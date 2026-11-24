import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCOPE_SUMMARY_MAX_BYTES,
  SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES,
} from "../validate-second-review-packet.mjs";
import { SECOND_REVIEW_FINDING_SUMMARY_MAX_BYTES } from "../second-review-material-contract.mjs";
import { repoPath } from "./lib/repo-root.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// Scenario: Evidence limit follows the contract constant in both carriers
test("SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES pins the evidence narrative contract value", () => {
  assert.equal(SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES, 8192);
});

test("second-review-material-contract.mjs owns the shared evidence narrative byte cap", () => {
  const materialSource = readFileSync(
    path.join(scriptDir, "../second-review-material-contract.mjs"),
    "utf8"
  );
  assert.match(
    materialSource,
    /export const SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES = 8_192;/,
    "material contract owns SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES"
  );
});

test("validate-second-review-packet.mjs enforces the shared evidence narrative byte cap", () => {
  const validatorSource = readFileSync(
    path.join(scriptDir, "../validate-second-review-packet.mjs"),
    "utf8"
  );
  assert.match(
    validatorSource,
    /maxBytes: SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES/,
    "evidence narrative validation MUST use SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES"
  );
  assert.doesNotMatch(
    validatorSource,
    /evidence\[\$\{index\}\]\.narrative",\s*item\.narrative,\s*\{\s*maxBytes:\s*1024/,
    "evidence narrative MUST NOT remain hardcoded at 1024"
  );
});

test("devpro:second-review SKILL documents the evidence narrative readability guard", () => {
  const skillSource = readFileSync(
    path.join(
      scriptDir,
      "../../agent-skills/devpro-reviews/second-review/SKILL.md"
    ),
    "utf8"
  );
  assert.match(
    skillSource,
    /evidence\[\]\.narrative.*8192 UTF-8 bytes/,
    "skill MUST document the 8192-byte evidence narrative cap"
  );
  assert.match(
    skillSource,
    /not a compression target/,
    "skill MUST carry readability-guard language for evidence narrative"
  );
});

// Collision guard (design D10, RK6): 8192 is also the verdict reason, approval_context, retry_context and
// previous_sticky cap, so every phrase below carries its own evidence field context (`evidence[].narrative`
// or the evidence section) and the number comes from the imported constant, never from a literal here.
const repoRoot = path.resolve(scriptDir, "../../..");
const max = SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES;
const maxWithComma = max.toLocaleString("en-US");
const readRepoFile = (relPath) => readFileSync(repoPath(relPath), "utf8");

// The text from the first occurrence of `anchor` to the next occurrence of `stop` (or the end of the text).
function sliceFrom(text, anchor, stop) {
  const start = text.indexOf(anchor);
  assert.notEqual(start, -1, `anchor not found: ${anchor}`);
  const end = stop ? text.indexOf(stop, start + anchor.length) : -1;
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

test("second-review SKILL states the evidence[].narrative cap from the contract constant", () => {
  const skill = readRepoFile(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");
  const sentence = sliceFrom(skill, "Each `evidence[].narrative` entry", "\n");
  assert.ok(
    sentence.includes(`MUST be at most ${max} UTF-8 bytes`),
    `second-review SKILL MUST state the evidence[].narrative cap as ${max} UTF-8 bytes`
  );
});

test("git-pr-template-and-merge.md states the evidence section limit and when it is enforced", () => {
  const rule = readRepoFile(".devpro/agent-rules/git-pr-template-and-merge.md");
  const paragraph = sliceFrom(rule, "**證據段長度與字樣限制**", "\n");
  assert.ok(
    paragraph.includes(`各自 ≤ ${max} UTF-8 bytes`),
    `the evidence section paragraph MUST state the evidence section limit as ${max} UTF-8 bytes`
  );
  assert.ok(paragraph.includes("PR 建立前由 lint 阻擋"), "the evidence section paragraph MUST say the lint blocks before PR creation");
  assert.ok(paragraph.includes("建立後 builder 仍會獨立檢查"), "the evidence section paragraph MUST say the builder still checks independently after creation");
  const blockLine = rule.split("\n").find((line) => line.startsWith("PreToolUse hook 也會在 `gh pr create`"));
  assert.ok(blockLine, "the PreToolUse body-file lint line MUST exist");
  assert.ok(blockLine.includes("證據段超長"), "the PreToolUse block conditions MUST name an over-limit evidence section");
});

test("canonical code-review-checklist states the evidence[].narrative cap in the requirement and the scenario", () => {
  const spec = readRepoFile("openspec/specs/code-review-checklist/spec.md");
  assert.ok(
    spec.includes(`Each \`evidence[].narrative\` MUST be a UTF-8 string of at most \`SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES\` (${maxWithComma}) bytes`),
    `the External Reviewer Packet Mode requirement MUST state the evidence[].narrative cap as (${maxWithComma}) bytes`
  );
  const scenario = sliceFrom(spec, "#### Scenario: Evidence Narrative Byte Cap Matches Readability-Guard Semantics", "\n#### ");
  assert.ok(
    scenario.includes(`an entry's \`narrative\` field is checked`) &&
      scenario.includes(`accepted up to \`SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES\` (${maxWithComma}) UTF-8 bytes`),
    `the narrative scenario MUST state the cap as (${maxWithComma}) UTF-8 bytes`
  );
});

test("pre-tool-mechanical-gates names SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES for the evidence section limit", () => {
  // The paragraph lives in the active change's delta until archive promotes it into the canonical spec;
  // check whichever carriers hold it, and require at least one so the guard cannot pass on nothing.
  const carriers = [
    "openspec/changes/strengthen-pre-pr-evidence-section-lint/specs/pre-tool-mechanical-gates/spec.md",
    "openspec/specs/pre-tool-mechanical-gates/spec.md",
  ].filter((relPath) => existsSync(repoPath(relPath)) && readRepoFile(relPath).includes("lib/pr-body-evidence-rules.mjs"));
  assert.ok(carriers.length > 0, "the evidence section limit paragraph MUST exist in the delta or in the canonical pre-tool-mechanical-gates spec");
  for (const relPath of carriers) {
    const paragraph = sliceFrom(readRepoFile(relPath), "evaluated through the shared `.devpro/scripts/lib/pr-body-evidence-rules.mjs` source", "\n");
    assert.ok(
      paragraph.includes(`over \`SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES\` (${maxWithComma}) UTF-8 bytes`),
      `${relPath}: the evidence section limit MUST be stated as SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES (${maxWithComma})`
    );
  }
});

// Scenario: Only one definition of the evidence rules exists
test("Only one definition of the evidence rules exists: EVIDENCE_MAX_BYTES is not defined outside tests", () => {
  // Whole-word match, so BOUNDED_TAIL_EVIDENCE_MAX_BYTES in the projection runner does not count.
  // A file walk instead of git grep keeps this test free of child processes (unit tier).
  const scriptsRoot = path.join(repoRoot, ".devpro/scripts");
  const testsRoot = path.join(scriptsRoot, "tests");
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (full === testsRoot) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\bEVIDENCE_MAX_BYTES\b/.test(readFileSync(full, "utf8"))) hits.push(path.relative(repoRoot, full));
    }
  };
  walk(scriptsRoot);
  assert.deepEqual(hits, [], "EVIDENCE_MAX_BYTES MUST have no match outside .devpro/scripts/tests");
});

// The module specifier must appear as a quoted string in code: block comments and line comments are stripped
// first, so a file name mentioned only in a header comment does not count as an import.
const importsEvidenceRules = (relPath) =>
  /["']\.\/lib\/pr-body-evidence-rules\.mjs["']/.test(
    readRepoFile(relPath)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1")
  );

test("Only one definition of the evidence rules exists: build-pr-sticky-handoff.mjs uses lib/pr-body-evidence-rules.mjs", () => {
  assert.ok(importsEvidenceRules(".devpro/scripts/build-pr-sticky-handoff.mjs"), "the handoff builder MUST import lib/pr-body-evidence-rules.mjs");
});

test("Only one definition of the evidence rules exists: pre-pr-body-template-check.mjs uses lib/pr-body-evidence-rules.mjs", () => {
  assert.ok(importsEvidenceRules(".devpro/scripts/pre-pr-body-template-check.mjs"), "the body lint MUST import lib/pr-body-evidence-rules.mjs");
});

test("Only one definition of the evidence rules exists: the other handoff caps stay at 4096", () => {
  assert.equal(SECOND_REVIEW_FINDING_SUMMARY_MAX_BYTES, 4096);
  assert.equal(SCOPE_SUMMARY_MAX_BYTES, 4096);
});
