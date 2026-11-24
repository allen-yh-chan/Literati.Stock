/**
 * strengthen-pre-change-clarification-grep.test.mjs
 *
 * Contract guards for limited multi-round pre-analyst clarification + thin lexicon
 * + Synthesis / Seams-first knives (change strengthen-pre-change-clarification).
 *
 * Covers Done When #1–#9 mechanical items + negative analyst-gate cases from design D8.
 * Style reference: strengthen-openspec-flow-rules-grep.test.mjs / clarify-ledger-schema-pointer-grep.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readdirSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";
import { readSourceFile as read } from "./lib/read.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";

const CHANGE_NAME = "strengthen-pre-change-clarification";


function activeOrArchivedChangePath(fileName) {
  const active = `openspec/changes/${CHANGE_NAME}/${fileName}`;
  if (existsSync(sourcePath(active))) return active;

  const archiveRoot = sourcePath("openspec/changes/archive");
  assert.ok(existsSync(archiveRoot), "openspec/changes/archive missing");
  const match = readdirSync(archiveRoot)
    .filter((entry) => entry.endsWith(`-${CHANGE_NAME}`))
    .sort()
    .at(-1);
  assert.ok(match, `archived ${CHANGE_NAME} change missing`);
  return `openspec/changes/archive/${match}/${fileName}`;
}

function extractDpChangeStep4(skillMd) {
  const start = skillMd.search(
    /\*\*第四步：Pre-analyst Clarification（MUST invoke `\/devpro:clarify`）\*\*/,
  );
  assert.ok(start >= 0, "devpro:change 缺第四步標題");
  const rest = skillMd.slice(start);
  const next = rest.search(/\n\*\*第五步：/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const AMB = read(".devpro/agent-rules/ambiguity-scoring.md");
const AMB_SPEC = read("openspec/specs/ambiguity-scoring/spec.md");
// 第四步 lives in the full-rigor reference; both copies use the full reading order.
const DP_CHANGE = readChangeSkillFullReadingOrder();
const DP_CHANGE_CLAUDE = readChangeSkillFullReadingOrder();
const STOP = read(".devpro/agent-rules/stop-point-comms.md");
const LEXICON_PATH = ".devpro/agent-rules/devpro-context-language.md";
const LEXICON = read(LEXICON_PATH);
const AGENTS = read("AGENTS.md");
const QUALITY = read(".devpro/agent-rules/openspec-quality-and-formats.md");
const PROPOSAL = read(".devpro/agent-rules/proposal-template.md");
const AUTHORING = read(
  ".devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md",
);
const AUTHORING_CLAUDE = read(".claude/skills/devpro/openspec/openspec-artifact-authoring/SKILL.md");
const STEP4 = extractDpChangeStep4(DP_CHANGE);

// ---------------------------------------------------------------------------
// R1 — Round-policy SSOT in ambiguity-scoring.md
// ---------------------------------------------------------------------------

test("R1: legacy single-round ban removed from ambiguity-scoring.md", () => {
  assert.equal(
    (AMB.match(/不 iterative loop、單輪完成/g) || []).length,
    0,
    "legacy「不 iterative loop、單輪完成」must be gone",
  );
});

test("R1: round = batch ≠ question + working cap 3 + absolute max 4", () => {
  assert.match(AMB, /batch≠question|不是.*一題一輪/, "batch≠question semantics missing");
  assert.match(AMB, /clarification batch/, "clarification batch missing");
  assert.match(AMB, /working cap 3/, "working cap 3 missing");
  assert.match(AMB, /absolute max 4/, "absolute max 4 missing");
  assert.match(AMB, /extension_used/, "extension_used missing");
  assert.match(AMB, /round4_completed/, "round4_completed missing");
});

test("R1 negative: no trigger + frontier non-empty forbids round 2", () => {
  assert.match(
    AMB,
    /MUST NOT 開 round 2|禁開 round 2|不得開 round 2/,
    "must forbid opening round 2 without multi-round trigger",
  );
});

test("R1/R7: cap_resolution + shared_understanding cannot bypass unresolved cap-hit", () => {
  assert.match(AMB, /cap_resolution/, "cap_resolution missing");
  assert.match(
    AMB,
    /shared_understanding=confirmed.*MUST NOT 呼叫 `dp-analyst`|即使 `shared_understanding=confirmed`.*MUST NOT/,
    "shared_understanding must not bypass unresolved cap-hit",
  );
});

test("R1 negative: split forbids analyst; carry-gaps requires gaps_written", () => {
  assert.match(
    AMB,
    /terminal=split.*MUST NOT 呼叫 `dp-analyst`|`split`：`terminal=split`，\*\*MUST NOT\*\* 呼叫/,
    "split must forbid dp-analyst",
  );
  assert.match(AMB, /gaps_written/, "gaps_written missing for carry-gaps path");
  assert.match(
    AMB,
    /carry-gaps.*gaps_written|gaps_written=true.*carry-gaps|`carry-gaps`：缺口已寫入/,
    "carry-gaps must require durable gaps write",
  );
  assert.match(
    AMB,
    /carry-gaps.*UNRESOLVED:|unresolved.*UNRESOLVED:.*耐久|禁只靠 boolean/,
    "carry-gaps must require durable UNRESOLVED unresolved evidence",
  );
});

test("R1/R7: extension requires round4_completed; second +1 forbidden", () => {
  assert.match(
    AMB,
    /round4_completed=true|僅 `round4_completed=true`/,
    "extend path must require round4_completed",
  );
  assert.match(AMB, /重複 \+1 \*\*禁止\*\*|重複 \+1.*禁止/, "second +1 must be forbidden");
});

test("R1/R7: terminal includes abort; Write-back Abort fallback; no analyst without recorded terminal", () => {
  assert.match(
    AMB,
    /terminal:.*abort|terminal` 含 `abort`|shared-understanding \| abort/,
    "terminal enum must include abort",
  );
  assert.match(AMB, /## Write-back Abort/, "Write-back Abort fallback heading missing");
  assert.match(
    AMB,
    /未成功 retry 且無 recorded terminal → \*\*MUST NOT\*\* 呼叫 `dp-analyst`/,
    "failed write without recorded terminal must block analyst",
  );
});

test("R5: field bounds + provenance MUST + no transcript/PII", () => {
  assert.match(AMB, /Field bounds|field-overflow/, "field bounds missing");
  assert.match(AMB, /Provenance MUST|\(provenance: user\|repo-fact\)/, "provenance MUST missing");
  assert.match(AMB, /no PII\/secrets\/transcript|禁.*transcript|非 full transcript/, "transcript forbid missing");
  assert.match(
    AMB,
    /shared_understanding_provenance/,
    "shared_understanding_provenance field missing",
  );
  assert.match(
    AMB,
    /clarification-contract\.mjs/,
    "executable clarification-contract pointer missing",
  );
});

test("R4: Seams bypass=ask-first-recorded requires non-empty bypass_reason", () => {
  assert.match(
    PROPOSAL,
    /MUST non-empty when bypass=ask-first-recorded|ask-first-recorded.*bypass_reason.*非空/,
    "bypass_reason non-empty obligation missing",
  );
});

test("R6: folklore metrics manual-only (not CI fail)", () => {
  assert.match(AMB, /manual-only/, "manual-only folklore marker missing");
  assert.match(AMB, /禁作 CI fail|非 CI fail|禁.*CI fail/, "must forbid folklore as CI fail");
});

test("R1 Purpose: canonical ambiguity-scoring spec no longer absolute single-round ban", () => {
  assert.doesNotMatch(
    AMB_SPEC,
    /no iterative loop|single-round \/ single-agent|不 iterative loop/,
    "Purpose must not keep absolute single-round / no-iterative-loop ban",
  );
  assert.match(AMB_SPEC, /limited multi-round|working hard cap 3|absolute max 4/, "Purpose must state limited multi-round + caps");
});

// ---------------------------------------------------------------------------
// R1 — devpro:change / stop-point pointer-only (no dual-write caps)
// ---------------------------------------------------------------------------

test("R1: devpro:change both paths remove 禁止分多輪追問", () => {
  for (const [label, body] of [
    ["shared", DP_CHANGE],
    ["claude", DP_CHANGE_CLAUDE],
  ]) {
    assert.equal(
      (body.match(/禁止分多輪追問/g) || []).length,
      0,
      `${label} devpro:change still has 禁止分多輪追問`,
    );
  }
});

test("R1 negative: skill step 4 is pointer-only (no dual-write working cap / absolute max / trigger set)", () => {
  for (const banned of [
    /working cap 3/,
    /absolute max 4/,
    /ambiguity\s*≥\s*0\.30/,
    /extension_used/,
  ]) {
    assert.doesNotMatch(
      STEP4,
      banned,
      `devpro:change step 4 must not dual-write round rule ${banned}`,
    );
  }
  assert.match(STEP4, /ambiguity-scoring\.md/, "step 4 must pointer ambiguity-scoring");
  assert.match(STEP4, /proposal-template\.md/, "step 4 must pointer proposal-template");
  assert.match(STEP4, /openspec-quality-and-formats\.md/, "step 4 must pointer openspec-quality");
  assert.match(STEP4, /stop-point-comms\.md/, "step 4 must pointer stop-point-comms");
});

test("R1: stop-point-comms pointer-only (no independent cap/trigger body)", () => {
  assert.match(STOP, /ambiguity-scoring\.md/, "stop-point must pointer ambiguity-scoring");
  const clarification = STOP.match(/### Clarification \/ cap-hit stop[\s\S]*?(?=\n### |\n## |$)/);
  assert.ok(clarification, "Clarification / cap-hit stop section missing");
  assert.doesNotMatch(
    clarification[0],
    /working cap 3|absolute max 4|ambiguity\s*≥\s*0\.30/,
    "stop-point clarification section must not restate caps/triggers",
  );
  assert.match(
    clarification[0],
    /post-round-4|MUST NOT.*再呈 extend|extension_used=true.*MUST NOT.*extend/,
    "stop-point must exclude extend after absolute-max / post-round-4",
  );
});

// ---------------------------------------------------------------------------
// R2 — thin lexicon
// ---------------------------------------------------------------------------

test("R2: lexicon leaf exists with _Avoid_ + pointer; AGENTS discoverable; no mandatory product CONTEXT.md", () => {
  assert.ok(existsSync(sourcePath(LEXICON_PATH)), "lexicon leaf missing");
  assert.match(LEXICON, /_Avoid_/, "lexicon must contain _Avoid_");
  assert.match(LEXICON, /ambiguity-scoring\.md/, "lexicon must pointer ambiguity-scoring");
  assert.match(AGENTS, /流程說詞\/lexicon|devpro-context-language/, "AGENTS trigger index must discover lexicon");
  assert.doesNotMatch(
    LEXICON,
    /MUST(?! NOT).{0,40}CONTEXT\.md|強制產品.*CONTEXT\.md.*MUST/,
    "lexicon must not mandate product CONTEXT.md as a positive MUST",
  );
});

// ---------------------------------------------------------------------------
// R3 — Synthesis mode
// ---------------------------------------------------------------------------

test("R3: Synthesis mode + UNRESOLVED: in openspec-quality; template/authoring pointer-only", () => {
  assert.match(QUALITY, /Synthesis mode/, "Synthesis mode missing in quality SSOT");
  assert.match(QUALITY, /UNRESOLVED:/, "UNRESOLVED: missing in quality SSOT");
  for (const [label, body] of [
    ["proposal-template", PROPOSAL],
    ["authoring-shared", AUTHORING],
    ["authoring-claude", AUTHORING_CLAUDE],
  ]) {
    assert.match(body, /Synthesis mode|openspec-quality-and-formats\.md/, `${label} must pointer synthesis SSOT`);
    assert.doesNotMatch(
      body,
      /### Synthesis mode/,
      `${label} must not dual-write ### Synthesis mode body`,
    );
  }
});

// ---------------------------------------------------------------------------
// R4 — Seams-first
// ---------------------------------------------------------------------------

test("R4: Seams-first + Seams Confirmation with reconfirm + ask-first-recorded bypass", () => {
  assert.match(PROPOSAL, /Seams-first/, "Seams-first missing");
  assert.match(PROPOSAL, /Seams Confirmation/, "Seams Confirmation missing");
  assert.match(PROPOSAL, /reconfirm_required/, "reconfirm_required missing");
  assert.match(PROPOSAL, /invalidation_reason/, "invalidation_reason missing");
  assert.match(PROPOSAL, /frontier-change|seams-change/, "frontier/seams invalidation reasons missing");
  assert.match(PROPOSAL, /ask-first-recorded/, "bypass must be ask-first-recorded");
  assert.match(
    PROPOSAL,
    /MUST NOT.*削弱.*archive|不削弱 archive|MUST NOT.*削弱 archive/,
    "must not weaken archive/validate/prove-it",
  );
});

test("R4: quality/authoring/devpro:change only pointer seams (no second seams schema)", () => {
  assert.match(QUALITY, /proposal-template\.md/, "quality must pointer seams SSOT");
  assert.doesNotMatch(QUALITY, /## Seams Confirmation/, "quality must not host Seams Confirmation schema");
  for (const [label, body] of [
    ["authoring", AUTHORING],
    ["dp-change-step4", STEP4],
  ]) {
    assert.match(body, /proposal-template\.md|Seams-first/, `${label} must pointer seams`);
    assert.doesNotMatch(body, /## Seams Confirmation/, `${label} must not dual-write Seams Confirmation schema`);
  }
});

// ---------------------------------------------------------------------------
// R9 — archive / validate / prove-it anchors not weakened by this change's carriers
// ---------------------------------------------------------------------------

test("R9 regression: proposal-template still anchors archive / validate / prove-it obligations", () => {
  assert.match(PROPOSAL, /pre-pr-archive-gate\.mjs/, "archive gate anchor must remain");
  assert.match(PROPOSAL, /prove-it/, "prove-it seam wording must remain available");
  assert.match(PROPOSAL, /openspec-step-1-to-9\.md/, "openspec step cross-ref must remain");
});

test("R9 regression: quality leaf still ties archive / prove-it / validate carriers", () => {
  assert.match(QUALITY, /pre-pr-archive-gate\.mjs/, "quality archive gate carrier missing");
  assert.match(QUALITY, /prove-it/, "quality prove-it obligation missing");
  assert.match(QUALITY, /openspec validate|lint-delta-requirement-mode/, "validate/lint carrier missing");
});

// ---------------------------------------------------------------------------
// Design gate invariant anchor (Done When #9)
// ---------------------------------------------------------------------------

test("Done When #9: design second-review gate invariant recorded in change design/proposal", () => {
  const design = read(activeOrArchivedChangePath("design.md"));
  const proposal = read(activeOrArchivedChangePath("proposal.md"));
  const blob = design + "\n" + proposal;
  assert.match(
    blob,
    /MUST NOT 建立或 finalize `tasks\.md`|不得建立／finalize `tasks\.md`/,
    "design/proposal must state tasks.md gate invariant",
  );
  assert.match(blob, /Design\.md Second-Review Gate|Design Gate/, "Design Gate named");
});

test("WARN follow-up: archive meeting-notes dogfood Clarification State + Seams Confirmation", () => {
  const notes = read(activeOrArchivedChangePath("meeting-notes.md"));
  assert.match(notes, /## Clarification State/, "Clarification State dogfood missing");
  assert.match(notes, /## Seams Confirmation/, "Seams Confirmation dogfood missing");
  assert.match(notes, /shared_understanding_provenance:\s*user/, "dogfood missing user provenance");
});

test("WARN follow-up: quality Verification restores decisions/scope-change/prove-it greps", () => {
  const ver = QUALITY.match(/## Verification[\s\S]*?```bash([\s\S]*?)```/);
  assert.ok(ver, "Verification bash block missing");
  const block = ver[1];
  // Active (non-comment) lines only — comments may be trimmed for token cap;
  // regression greps must remain as executable commands, not only Synthesis.
  const active = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .join("\n");
  assert.match(active, /grep "\^## D\[0-9\]"/, "decisions D# grep missing from Verification");
  assert.match(active, /grep "scope-change"/, "scope-change grep missing from Verification");
  assert.match(active, /grep "prove-it"/, "prove-it grep missing from Verification");
  assert.match(active, /Synthesis mode/, "Synthesis Verification grep missing");
  for (const needle of [
    'grep "^## D[0-9]"',
    'grep "prove-it"',
    'grep "scope-change"',
  ]) {
    assert.ok(
      active.includes(needle),
      `Verification must retain executable ${needle} (not deleted by Synthesis-only trim)`,
    );
  }
  // Explicit retain marker so PR diffs cannot be misread as "Synthesis-only".
  assert.match(
    block,
    /REQUIRED retain:.*\^## D\[0-9\].*prove-it.*scope-change/,
    "Verification must declare REQUIRED retain marker covering D#/prove-it/scope-change",
  );
});
