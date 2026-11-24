import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";
// Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const CORE = ".devpro/scripts/lib/review-remediation-evidence-core.mjs";

// Every literal the behavior-risk digest reads from the change artifacts.
// Each entry pairs the code-side literal with the wording the warning uses.
const DIGEST_INPUTS = [
  { code: "const touchRows = parseTouchStructuredRows(touchBoundary);", warning: "Touch 列" },
  { code: "parseRiskClasses(proposal)", warning: "`risk_classes`" },
  { code: '"Security/trust/privacy/data"', warning: "`Security/trust/privacy/data`" },
  { code: '"Material negatives/non-goals"', warning: "`Material negatives/non-goals`" },
  { code: '"## Risk Classes and Material Negatives"', warning: "`## Risk Classes and Material Negatives`" },
  { code: 'exactHeadingBlock(design, "## Decisions")', warning: "`### D<n>`" },
  { code: "/^### Requirement: (.+)$/u", warning: "`### Requirement:`" },
];

// The functions that decide what the behavior-risk digest reads. Their source
// is pinned as a whole: a new input can be added under an existing snapshot
// key without touching any literal in DIGEST_INPUTS, so literal presence alone
// does not prove the warning is complete.
const DIGEST_INPUT_FUNCTIONS = [
  "parseRiskClasses",
  "parseCapabilityRequirementDocuments",
  "parseArchitectureDecisions",
  "parseSafetyObligations",
  "parseTouchPathToken",
  "parseTouchStructuredRows",
  "behaviorRiskSnapshotFromDocuments",
];
const DIGEST_INPUT_FUNCTIONS_SHA256 = "08b175d797301328078e4ebd4741136aa7c3da9b669f54e8d919522c2869cef8";

function functionSource(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `${name} must be a top-level function in the digest source`);
  const end = source.indexOf("\nfunction ", start + 1);
  assert.ok(end > start, `${name} must be followed by another top-level function`);
  return source.slice(start + 1, end);
}

function warningLine() {
  const lines = readPrePrSkillFullReadingOrder().split("\n").filter((line) => line.startsWith("**Partial 之後修 Suggestion 的重審成本**"));
  assert.equal(lines.length, 1, "the rereview-cost warning must be exactly one physical line");
  return lines[0];
}

function behaviorRiskSource() {
  const source = read(CORE);
  const start = source.indexOf("function parseCapabilityRequirementDocuments(");
  const end = source.indexOf("function riskShapeSnapshotFromDocuments(");
  assert.ok(start >= 0 && end > start, "behavior-risk snapshot functions must be locatable");
  return source.slice(start, end);
}

test("rereview-cost warning names every behavior-risk digest input", () => {
  const line = warningLine();
  for (const { warning } of DIGEST_INPUTS) {
    assert.ok(line.includes(warning), `warning must name ${warning}`);
  }
});

test("behavior-risk digest still reads exactly the inputs the warning lists", () => {
  const source = behaviorRiskSource();
  for (const { code } of DIGEST_INPUTS) {
    assert.ok(source.includes(code), `digest source no longer contains ${code}; update the warning and this table together`);
  }
  const snapshot = source.slice(source.indexOf("function behaviorRiskSnapshotFromDocuments("));
  const keys = [...snapshot.matchAll(/^ {4}([a-z_]+):/gmu)].map((match) => match[1]);
  assert.deepEqual(
    keys,
    ["schema", "digest_alg", "change_id", "risk_classes", "capabilities", "touch_rows", "architecture_decisions", "safety_obligations"],
    "behavior-risk snapshot gained or lost a top-level input; update the warning and this table together",
  );
});

test("behavior-risk digest input functions are unchanged since the warning was last checked", () => {
  const source = read(CORE);
  const actual = createHash("sha256")
    .update(DIGEST_INPUT_FUNCTIONS.map((name) => functionSource(source, name)).join("\n"))
    .digest("hex");
  assert.equal(
    actual,
    DIGEST_INPUT_FUNCTIONS_SHA256,
    "a function that decides the behavior-risk digest inputs changed; re-read it, update the warning in "
      + `${SKILL} and DIGEST_INPUTS if the set of inputs changed, then update DIGEST_INPUT_FUNCTIONS_SHA256`,
  );
});

test("behavior-risk snapshot calls no input parser outside the pinned set", () => {
  const snapshot = functionSource(read(CORE), "behaviorRiskSnapshotFromDocuments");
  const called = [...new Set([...snapshot.matchAll(/\b(parse[A-Za-z]+)\(/gu)].map((match) => match[1]))].sort();
  const pinned = DIGEST_INPUT_FUNCTIONS.filter((name) => name.startsWith("parse") && name !== "parseTouchPathToken").sort();
  assert.deepEqual(called, pinned);
});

test("rereview-cost warning keeps the avoid-or-assess obligation on the same line", () => {
  assert.match(warningLine(), /MUST 避開上列各處，或先評估該重審成本再動手/u);
});
