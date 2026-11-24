/**
 * strengthen-matt-skill-mechanisms-grep.test.mjs
 *
 * Contract guards for red-capable／agent-runnable loop gate, writing-for-agents
 * mechanism anchors (no parallel leaf), Feathers≠Seams-first disambiguation,
 * Batch4 tip anchors, and forever-reject negatives (R5).
 *
 * Style reference: strengthen-pre-change-clarification-grep.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";
import { readSourceFile as read } from "./lib/read.mjs";



const TROUBLESHOOTING = read(".devpro/agent-rules/troubleshooting.md");
const TESTING = read(".devpro/agent-rules/testing-and-qa.md");
// Load-chain leaf of testing-and-qa.md (text moved verbatim); the forever-reject scan below keeps covering it.
const SUITE_CADENCE = read(".devpro/agent-rules/test-suite-cadence.md");
const AGENTS_MD_MAINT = read(".devpro/agent-rules/agents-md-maintenance.md");
const TOKEN = read(".devpro/agent-rules/token-frugal-io.md");
const DOC_SPLIT = read(".devpro/agent-rules/doc-split-and-dedup-sop.md");
const DESIGN = read(".devpro/agent-rules/design-core.md");
const ANTI_EX = read(".devpro/agent-rules/anti-patterns-examples.md");
const LEXICON = read(".devpro/agent-rules/devpro-context-language.md");
const PROPOSAL_TMPL = read(".devpro/agent-rules/proposal-template.md");
const KNOWLEDGE = read(".devpro/agent-rules/knowledge-digest.md");
const INGEST = read(".devpro/agent-rules/rule-ingest-methodology.md");
const CODE_REVIEW = read(".devpro/agent-rules/code-review-checklist.md");

// ---------------------------------------------------------------------------
// R1 — red-capable／agent-runnable gate + negative contract fixture
// ---------------------------------------------------------------------------

test("R1: troubleshooting has red-capable and agent-runnable gate", () => {
  assert.match(TROUBLESHOOTING, /red-capable/);
  assert.match(TROUBLESHOOTING, /agent-runnable/);
  assert.match(
    TROUBLESHOOTING,
    /MUST NOT.*confirmed root cause|不得.*confirmed root cause|MUST NOT.*把僅敘述性 hypothesis/,
    "must forbid confirmed root cause without loop",
  );
});

test("R1: loop checklist field names exist", () => {
  assert.match(TROUBLESHOOTING, /loop_command/);
  assert.match(TROUBLESHOOTING, /loop_red_capable/);
  assert.match(TROUBLESHOOTING, /loop_agent_runnable/);
});

test("R1: agent-runnable binds ai-autonomy Ask First／Never", () => {
  assert.match(TROUBLESHOOTING, /ai-autonomy\.md/);
  assert.match(TROUBLESHOOTING, /Ask First/);
  assert.match(TROUBLESHOOTING, /Never/);
});

test("R1: testing-and-qa pointers to troubleshooting red-capable gate", () => {
  assert.match(TESTING, /red-capable|agent-runnable/);
  assert.match(TESTING, /troubleshooting\.md/);
});

/**
 * R1 negative-contract fixture (design D6):
 * When the red-capable／agent-runnable gate text exists, a narrative-only
 * hypothesis MUST NOT be an allowed confirmed-root-cause path.
 * Mechanical evidence = normative ban phrase present + rationalization slogans
 * absent from the troubleshooting allow-path wording.
 */
test("R1 negative fixture: narrative-only hypothesis is not an allowed confirmed-root-cause path", () => {
  assert.match(
    TROUBLESHOOTING,
    /無此迴圈|無.*red-capable|Without that loop|MUST NOT.*僅敘述性 hypothesis|僅敘述性 hypothesis.*confirmed root cause/,
    "normative ban for narrative-only path must exist",
  );
  // Forbidden rationalizations must not appear as permitted paths near the gate.
  assert.doesNotMatch(
    TROUBLESHOOTING,
    /口頭「看起來壞了」即可命名 confirmed root cause|narrative hypothesis alone is enough to name confirmed root cause/,
  );
  assert.doesNotMatch(
    TROUBLESHOOTING,
    /無 red-capable 亦可 confirmed root cause|without red-capable.*MAY name confirmed root cause/i,
  );
});

// ---------------------------------------------------------------------------
// R2 — writing-for-agents mechanisms; no parallel leaf
// ---------------------------------------------------------------------------

test("R2: context pointer and leading words in agents-md-maintenance", () => {
  assert.match(AGENTS_MD_MAINT, /context pointer/);
  assert.match(AGENTS_MD_MAINT, /leading words/);
});

test("R2: cognitive load in token-frugal-io", () => {
  assert.match(TOKEN, /cognitive load/);
});

test("R2: progressive disclosure in doc-split-and-dedup-sop", () => {
  assert.match(DOC_SPLIT, /progressive disclosure/);
});

test("R2: positive recipe remains／expanded in design-core", () => {
  assert.match(DESIGN, /Positive Executable Recipe First/);
  assert.match(DESIGN, /positive/);
});

test("R2: writing-for-agents.md parallel leaf must not exist", () => {
  assert.equal(
    existsSync(sourcePath(".devpro/agent-rules/writing-for-agents.md")),
    false,
  );
});

// ---------------------------------------------------------------------------
// R3 — Feathers ≠ Seams-first; proposal-template Seams-first retained
// ---------------------------------------------------------------------------

test("R3: design-core Feathers seam and disambiguation", () => {
  assert.match(DESIGN, /Feathers seam/);
  assert.match(
    DESIGN,
    /Feathers seam ≠ OpenSpec Seams-first|Feathers seam != OpenSpec Seams-first/,
  );
  assert.match(DESIGN, /Module/);
  assert.match(DESIGN, /Interface/);
  assert.match(DESIGN, /Depth/);
  assert.match(DESIGN, /Adapter/);
  assert.match(DESIGN, /Leverage/);
  assert.match(DESIGN, /Locality/);
});

test("R3: anti-patterns-examples collision case + lexicon Avoid row", () => {
  assert.match(ANTI_EX, /Feathers seam ≠ OpenSpec Seams-first|Feathers seam/);
  assert.match(ANTI_EX, /❌/);
  assert.match(ANTI_EX, /✅/);
  assert.match(LEXICON, /Feathers seam/);
  assert.match(LEXICON, /_Avoid_/);
  assert.match(LEXICON, /design-core\.md/);
  assert.match(LEXICON, /proposal-template\.md/);
});

test("R3 regression: proposal-template Seams-first still present", () => {
  assert.match(PROPOSAL_TMPL, /Seams-first/);
});

// ---------------------------------------------------------------------------
// R4 — Batch4 light tip anchors
// ---------------------------------------------------------------------------

test("R4: knowledge-digest and rule-ingest primary-source／cited durable", () => {
  assert.match(KNOWLEDGE, /primary-source/);
  assert.match(KNOWLEDGE, /cited durable|禁只摘要/);
  assert.match(INGEST, /primary-source/);
  assert.match(INGEST, /cited durable|禁只摘要/);
});

test("R4: code-review smell heuristics + testing anti-tautology", () => {
  assert.match(CODE_REVIEW, /[Ss]mell/);
  assert.match(TESTING, /anti-tautology/);
});

// ---------------------------------------------------------------------------
// R5 — forever reject negatives
// ---------------------------------------------------------------------------

test("R5 negative: no ask-matt／wayfinder／product CONTEXT mandate／parallel leaf", () => {
  for (const [name, body] of [
    ["troubleshooting", TROUBLESHOOTING],
    ["design-core", DESIGN],
    ["lexicon", LEXICON],
    ["testing-and-qa", TESTING],
    ["test-suite-cadence", SUITE_CADENCE],
  ]) {
    assert.doesNotMatch(body, /\bask-matt\b/i, `${name} must not introduce ask-matt`);
    assert.doesNotMatch(body, /\bwayfinder\b/i, `${name} must not introduce wayfinder`);
    assert.doesNotMatch(
      body,
      /\bteach-matt\b|\bask-matt\/wayfinder\b/i,
      `${name} must not introduce matt teach chrome`,
    );
  }
  // Affirmative product CONTEXT mandate only (existing Non-goals bans are keep-existing OK).
  assert.doesNotMatch(
    LEXICON,
    /MUST (?:create|require|mandate)\s+.*CONTEXT\.md|必須(?:建立|要求)產品\s*`?CONTEXT\.md/i,
  );
  assert.match(
    LEXICON,
    /MUST NOT 把本 leaf 讀成「強制產品|禁強制產品 `CONTEXT\.md`/,
    "keep-existing Non-goals ban must remain",
  );
  assert.equal(
    existsSync(sourcePath(".devpro/agent-rules/writing-for-agents.md")),
    false,
    "R5: no parallel writing-for-agents leaf",
  );
});
