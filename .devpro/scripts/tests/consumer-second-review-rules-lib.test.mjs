/**
 * consumer-second-review-rules-lib.test.mjs
 *
 * The two consumer local files are free-form markdown: the shared libraries keep
 * only pre-PR file paths; for second-review rules, one packet integrity
 * check (`checkConsumerReviewRulesBytes`) shared by the handoff builder and
 * doctor. These checks are pure; copied-file bootstrap is covered by the CLI portability suite.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as prePrChecksLib from "../lib/consumer-pre-pr-checks.mjs";
import * as rulesLib from "../lib/consumer-second-review-rules.mjs";
import { extractCredentialDenyTokens } from "../lib/second-review-sticky-credential-gate.mjs";

const {
  CONSUMER_SECOND_REVIEW_RULES_BASENAME,
  CONSUMER_SECOND_REVIEW_RULES_LEGACY_REL,
  CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES,
  CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS,
  CONSUMER_SECOND_REVIEW_RULES_REL,
  checkConsumerReviewRulesBytes,
} = rulesLib;

const bytes = (text) => Buffer.from(text, "utf8");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const codes = (result) => result.problems.map((problem) => problem.code);

test("pre-PR lib exports only the bootstrap-safe path constants", () => {
  assert.deepEqual(Object.keys(prePrChecksLib).sort(), [
    "CONSUMER_PRE_PR_CHECKS_BASENAME",
    "CONSUMER_PRE_PR_CHECKS_LEGACY_REL",
    "CONSUMER_PRE_PR_CHECKS_REL",
  ]);
  assert.equal(prePrChecksLib.CONSUMER_PRE_PR_CHECKS_REL, ".devpro/pre-pr-checks.local.md");
  assert.equal(prePrChecksLib.CONSUMER_PRE_PR_CHECKS_BASENAME, "pre-pr-checks.local.md");
  assert.equal(prePrChecksLib.CONSUMER_PRE_PR_CHECKS_LEGACY_REL, ".devpro/pre-pr-checks.local");
});

test("second-review rules lib exports the paths, the byte limit, the hints and the integrity check only", () => {
  assert.deepEqual(Object.keys(rulesLib).sort(), [
    "CONSUMER_SECOND_REVIEW_RULES_BASENAME",
    "CONSUMER_SECOND_REVIEW_RULES_LEGACY_REL",
    "CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES",
    "CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS",
    "CONSUMER_SECOND_REVIEW_RULES_REL",
    "checkConsumerReviewRulesBytes",
  ]);
  assert.equal(CONSUMER_SECOND_REVIEW_RULES_REL, ".devpro/second-review-rules.local.md");
  assert.equal(CONSUMER_SECOND_REVIEW_RULES_BASENAME, "second-review-rules.local.md");
  assert.equal(CONSUMER_SECOND_REVIEW_RULES_LEGACY_REL, ".devpro/second-review-rules.local");
  assert.equal(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES, 32768);
});

test("problem hints cover every code the check and the builder can report", () => {
  assert.deepEqual(Object.keys(CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS).sort(), [
    "credential-shape",
    "invalid-utf8",
    "not-a-regular-file",
    "nul-byte",
    "pii-or-secret-pattern",
    "too-large",
  ]);
  assert.match(CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS["too-large"], /32768|32,768/);
  for (const hint of Object.values(CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS)) {
    assert.match(hint, /^review stops/);
  }
});

test("ordinary markdown with headings, lists, code fences and non-ASCII text is carried unchanged", () => {
  const markdown = [
    "# Review rules",
    "",
    "## Naming",
    "",
    "- Every public method MUST validate its arguments before use.",
    "- 所有 API 回應必須包含 correlation id。",
    "",
    "```sh",
    "npm run lint # not a comment line",
    "```",
    "",
    "Tool usage and Rules for reviewers are plain words here.",
    "",
  ].join("\n");
  const result = checkConsumerReviewRulesBytes(bytes(markdown));
  assert.deepEqual(result.problems, []);
  assert.equal(result.text, markdown, "no trimming, no line removed, no comment syntax");
});

test("a leading byte order mark is removed and is not a problem", () => {
  const result = checkConsumerReviewRulesBytes(Buffer.concat([BOM, bytes("# Rules\nKeep it small.\n")]));
  assert.deepEqual(result.problems, []);
  assert.equal(result.text, "# Rules\nKeep it small.\n");
});

test("only one leading byte order mark is removed; a second one is carried as it is", () => {
  const result = checkConsumerReviewRulesBytes(Buffer.concat([BOM, BOM, bytes("# Rules\n")]));
  assert.deepEqual(result.problems, []);
  assert.equal(result.text, "\uFEFF# Rules\n");
});

test("a whitespace-only file yields the empty string and no problem", () => {
  for (const text of ["", "\n", " \t \r\n\n  \n"]) {
    const result = checkConsumerReviewRulesBytes(bytes(text));
    assert.deepEqual(result, { text: "", problems: [] }, JSON.stringify(text));
  }
  assert.deepEqual(checkConsumerReviewRulesBytes(Buffer.concat([BOM, bytes("  \n")])), { text: "", problems: [] });
});

test("the size limit counts UTF-8 bytes after the byte order mark is removed", () => {
  const atLimit = "a".repeat(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES);
  assert.deepEqual(codes(checkConsumerReviewRulesBytes(bytes(atLimit))), []);
  assert.deepEqual(codes(checkConsumerReviewRulesBytes(Buffer.concat([BOM, bytes(atLimit)]))), []);
  assert.deepEqual(codes(checkConsumerReviewRulesBytes(bytes(`${atLimit}a`))), ["too-large"]);
  // 10923 three-byte characters are 32769 bytes while 10923 < 32768 characters.
  assert.deepEqual(codes(checkConsumerReviewRulesBytes(bytes("規".repeat(10923)))), ["too-large"]);
});

test("a whitespace-only file over the limit is too-large, not empty", () => {
  const result = checkConsumerReviewRulesBytes(bytes(" ".repeat(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES + 1)));
  assert.deepEqual(codes(result), ["too-large"]);
  assert.equal(result.text, "");
});

test("undecodable bytes are invalid-utf8 and yield no text", () => {
  const result = checkConsumerReviewRulesBytes(Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  assert.deepEqual(codes(result), ["invalid-utf8"]);
  assert.equal(result.text, "");
});

test("a NUL byte anywhere is nul-byte", () => {
  const result = checkConsumerReviewRulesBytes(bytes("# Rules\nKeep it\u0000 small.\n"));
  assert.deepEqual(codes(result), ["nul-byte"]);
  assert.equal(result.text, "");
});

test("credential-shaped text is credential-shape and the problem never echoes the text", () => {
  // Assembled at run time so this file holds no credential-shaped literal.
  const secretPart = ["Sup3r", "S3cret"].join("");
  const shaped = `Connect with ${"pass"}${"word"}=${secretPart} first.`;
  assert.ok(extractCredentialDenyTokens({ materialTexts: [shaped] }).length > 0, "the sample must be credential-shaped");
  const result = checkConsumerReviewRulesBytes(bytes(`# Rules\n${shaped}\n`));
  assert.deepEqual(codes(result), ["credential-shape"]);
  assert.equal(result.text, "");
  assert.ok(!JSON.stringify(result).includes(secretPart), "problems must not echo the shaped text");
});

test("every problem is blocking and carries only a code and an optional numeric detail", () => {
  const samples = [
    Buffer.from([0xff]),
    bytes("a\u0000"),
    bytes("a".repeat(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES + 1)),
  ];
  for (const sample of samples) {
    for (const problem of checkConsumerReviewRulesBytes(sample).problems) {
      assert.equal(problem.blocking, true);
      assert.deepEqual(Object.keys(problem).sort(), ["blocking", "code", "detail"]);
      assert.ok(problem.detail === null || typeof problem.detail === "number");
    }
  }
});
