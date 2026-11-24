import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SECOND_REVIEW_VERDICT_REASON_MAX_BYTES,
  SECOND_REVIEW_PACKET_STATIC_SUFFIX,
  secondReviewPacketStaticPrefix,
} from "../validate-second-review-packet.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectionSource = readFileSync(
  path.join(scriptDir, "../run-second-reviewer-projection.mjs"),
  "utf8"
);

test("SECOND_REVIEW_VERDICT_REASON_MAX_BYTES pins the verdict-reason contract value", () => {
  assert.equal(SECOND_REVIEW_VERDICT_REASON_MAX_BYTES, 8192);
});

test("run-second-reviewer-projection.mjs imports the cap instead of re-hardcoding it", () => {
  assert.match(
    projectionSource,
    /import\s*\{[^}]*\bSECOND_REVIEW_VERDICT_REASON_MAX_BYTES\b[^}]*\}\s*from\s*"\.\/validate-second-review-packet\.mjs"/s,
    "projection module MUST import SECOND_REVIEW_VERDICT_REASON_MAX_BYTES from validate-second-review-packet.mjs"
  );
  assert.match(
    projectionSource,
    /const verdictReasonByteCap = SECOND_REVIEW_VERDICT_REASON_MAX_BYTES;/,
    "verdictReasonByteCap MUST be bound to the imported contract constant"
  );
  assert.doesNotMatch(
    projectionSource,
    /verdictReasonByteCap\s*=\s*8192/,
    "verdictReasonByteCap MUST NOT be re-hardcoded to a literal 8192"
  );
  assert.doesNotMatch(
    projectionSource,
    /\b8192\b/,
    "projection source MUST NOT contain a standalone re-hardcoded 8192 literal"
  );
  assert.doesNotMatch(
    projectionSource,
    /8,192/,
    "projection source MUST NOT contain a standalone re-hardcoded 8,192 literal"
  );
});

test("SECOND_REVIEW_PACKET_STATIC_SUFFIX JSON example derives its max-bytes token from the contract constant", () => {
  assert.ok(
    SECOND_REVIEW_PACKET_STATIC_SUFFIX.includes(
      `max-${SECOND_REVIEW_VERDICT_REASON_MAX_BYTES}-bytes`
    ),
    "static suffix JSON example MUST derive its max-bytes token from SECOND_REVIEW_VERDICT_REASON_MAX_BYTES"
  );
});

test("secondReviewPacketStaticPrefix guidance line derives its byte count from the contract constant", () => {
  const prefix = secondReviewPacketStaticPrefix("Claude Code", "pr-sticky");
  assert.ok(
    prefix.includes(`at most ${SECOND_REVIEW_VERDICT_REASON_MAX_BYTES} bytes`),
    "static prefix guidance line MUST derive its byte count from SECOND_REVIEW_VERDICT_REASON_MAX_BYTES"
  );
});

test("page-window completion parser source enforces the shared reason byte cap", () => {
  const materialSource = readFileSync(
    path.join(scriptDir, "../second-review-material-contract.mjs"),
    "utf8"
  );
  assert.match(
    materialSource,
    /export const SECOND_REVIEW_VERDICT_REASON_MAX_BYTES = 8_192;/,
    "material contract owns the shared SECOND_REVIEW_VERDICT_REASON_MAX_BYTES constant"
  );
  assert.match(
    materialSource,
    /Buffer\.byteLength\(completion\.reason, "utf8"\) > SECOND_REVIEW_VERDICT_REASON_MAX_BYTES/,
    "parsePageWindowCompletionObject MUST enforce the shared reason byte cap"
  );
});
