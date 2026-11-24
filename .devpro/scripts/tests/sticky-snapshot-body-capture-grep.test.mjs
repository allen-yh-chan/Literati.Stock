/**
 * Prove-it for #2266: sticky_authority_snapshot body capture matches runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";

const FILES = [
  ".devpro/agent-rules/post-pr-completion-gate.md",
  ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md",
  // The packet／control-binding snapshot capture rule moved verbatim from code-review-cross-model.md.
  ".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md",
  "openspec/specs/code-review-checklist/spec.md",
];

test("#2266 carriers name liveStickyAuthoritySnapshot capture and forbid --jq", () => {
  for (const rel of FILES) {
    const text = readFileSync(sourcePath(rel), "utf8");
    assert.match(text, /liveStickyAuthoritySnapshot/, `${rel} missing liveStickyAuthoritySnapshot`);
    assert.match(text, /--paginate/, `${rel} missing --paginate`);
    assert.match(text, /--slurp/, `${rel} missing --slurp`);
    assert.match(text, /MUST NOT/, `${rel} missing MUST NOT`);
    assert.match(text, /--jq/, `${rel} missing --jq forbid token`);
  }
});

test("#2266 spec names Text-Pipeline Body Capture Is Forbidden", () => {
  const spec = readFileSync(
    sourcePath("openspec/specs/code-review-checklist/spec.md"),
    "utf8",
  );
  assert.match(spec, /Text-Pipeline Body Capture Is Forbidden/);
});
