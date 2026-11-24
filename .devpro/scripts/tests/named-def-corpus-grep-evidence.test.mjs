/**
 * Prove-it coverage for #2526 named-definition corpus-grep evidence gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateNamedDefCorpusGrepEvidence,
  noneEvidenceMarkdown,
  presentEvidenceMarkdown,
  NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING,
} from "../lib/named-def-corpus-grep-evidence.mjs";

function wrap(section) {
  return `# Proposal\n\n## Why\n\nx\n\n${section}`;
}

test("missing section fails and names undeclared definitions", () => {
  const verdict = evaluateNamedDefCorpusGrepEvidence("# Proposal\n\n## Why\n\nx\n");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "section-missing");
  assert.match(verdict.reason, new RegExp(NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING));
  assert.deepEqual(verdict.missingDefinitions, ["(undeclared — section absent)"]);
});

test("duplicate section fails closed and names malformed definitions", () => {
  const body = [
    "# Proposal",
    "",
    noneEvidenceMarkdown("first"),
    noneEvidenceMarkdown("second"),
  ].join("\n");
  const verdict = evaluateNamedDefCorpusGrepEvidence(body);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "section-duplicate");
  assert.match(verdict.reason, /exactly one/);
  assert.deepEqual(verdict.missingDefinitions, [
    "(undeclared — evidence malformed)",
  ]);
});

test("status none without reason fails with missingDefinitions", () => {
  const body = wrap(
    `## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING}\n\n\`\`\`json\n{"status":"none","reason":""}\n\`\`\`\n`,
  );
  const verdict = evaluateNamedDefCorpusGrepEvidence(body);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "none-reason-missing");
  assert.deepEqual(verdict.missingDefinitions, [
    "(undeclared — evidence malformed)",
  ]);
});

test("status none with reason passes", () => {
  const verdict = evaluateNamedDefCorpusGrepEvidence(
    wrap(noneEvidenceMarkdown("rename-only in canonical carrier")),
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, "none");
});

test("present definition missing scope/hits/disposition fails with field gaps", () => {
  const body = wrap(
    presentEvidenceMarkdown([
      { name: "stalled_rounds", scope: "", hits: "", disposition: "" },
    ]),
  );
  const verdict = evaluateNamedDefCorpusGrepEvidence(body);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "definition-fields-incomplete");
  assert.ok(verdict.missingDefinitions.includes("stalled_rounds"));
  assert.deepEqual(verdict.fieldGaps[0].missing.sort(), [
    "disposition",
    "hits|results",
    "scope",
  ]);
});

test("present definition with results alias and disposition passes", () => {
  const verdict = evaluateNamedDefCorpusGrepEvidence(
    wrap(
      presentEvidenceMarkdown([
        {
          name: "replaceDurableFile",
          scope: ".devpro/scripts --include='*.mjs'",
          results: "4 self carriers; 0 non-self",
          disposition: "self-only",
        },
      ]),
    ),
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, "present");
});

test("present definition accepts numeric hits and array results", () => {
  const body = wrap(
    `## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING}\n\n\`\`\`json\n${JSON.stringify(
      {
        status: "present",
        definitions: [
          {
            name: "numericHits",
            scope: ".devpro/scripts",
            hits: 3,
            disposition: "self-only",
          },
          {
            name: "arrayResults",
            scope: ".devpro/scripts",
            results: ["self-a", "self-b"],
            disposition: "self-only",
          },
        ],
      },
      null,
      2,
    )}\n\`\`\`\n`,
  );
  const verdict = evaluateNamedDefCorpusGrepEvidence(body);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, "present");
});

test("prose and historical quotes alone are not treated as new definitions", () => {
  const body = [
    "# Proposal",
    "",
    "## Why",
    "",
    'Historical note mentioning "stalled_rounds" and REVIEW_STALL_ROUND_CAP.',
    "",
    noneEvidenceMarkdown("quoted/historical mentions are not new definitions"),
  ].join("\n");
  const verdict = evaluateNamedDefCorpusGrepEvidence(body);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, "none");
});

test("malformed json fence fails closed with missingDefinitions", () => {
  const body = wrap(
    `## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING}\n\n\`\`\`json\n{status: present}\n\`\`\`\n`,
  );
  const verdict = evaluateNamedDefCorpusGrepEvidence(body);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "json-parse-error");
  assert.deepEqual(verdict.missingDefinitions, [
    "(undeclared — evidence malformed)",
  ]);
});

test("multiple json fences fail closed", () => {
  const body = wrap(
    [
      `## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING}`,
      "",
      "```json",
      '{"status":"none","reason":"first"}',
      "```",
      "",
      "```json",
      '{"status":"none","reason":"second"}',
      "```",
      "",
    ].join("\n"),
  );
  const verdict = evaluateNamedDefCorpusGrepEvidence(body);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "json-fence-multiple");
  assert.deepEqual(verdict.missingDefinitions, [
    "(undeclared — evidence malformed)",
  ]);
});

test("status-invalid and json-fence-missing name malformed definitions", () => {
  const invalidStatus = wrap(
    `## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING}\n\n\`\`\`json\n{"status":"maybe","reason":"x"}\n\`\`\`\n`,
  );
  const noFence = wrap(
    `## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING}\n\nstatus: none\n`,
  );
  const invalid = evaluateNamedDefCorpusGrepEvidence(invalidStatus);
  const missing = evaluateNamedDefCorpusGrepEvidence(noFence);
  assert.equal(invalid.code, "status-invalid");
  assert.equal(missing.code, "json-fence-missing");
  assert.deepEqual(invalid.missingDefinitions, [
    "(undeclared — evidence malformed)",
  ]);
  assert.deepEqual(missing.missingDefinitions, [
    "(undeclared — evidence malformed)",
  ]);
});
