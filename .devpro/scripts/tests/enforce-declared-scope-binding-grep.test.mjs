/**
 * Grep anchors for enforce-declared-scope-binding (#2480 / #2482).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("proposal-template binds seams_fingerprint to content hash (#2480)", () => {
  const body = read(".devpro/agent-rules/proposal-template.md");
  assert.match(body, /sha256\(canonical\(seams\)\)/);
  assert.match(body, /computeSeamsContentFingerprint/);
  assert.match(body, /自由文字 fingerprint \*\*禁止\*\*/);
  assert.match(body, /MUST NOT.*只重算 hash|MUST NOT only recompute/i);
  assert.match(body, /reconfirm_required=true.*invalidation_reason=seams-change.*confirmed=false/s);
  assert.doesNotMatch(body, /seams_fingerprint: ≤64 chars stable id/);
});

test("clarification-contract exports content fingerprint helper (#2480)", () => {
  const body = read(".devpro/scripts/lib/clarification-contract.mjs");
  assert.match(body, /export function computeSeamsContentFingerprint/);
  assert.match(body, /seams_fingerprint must equal sha256\(canonical\(seams\)\)/);
  assert.match(body, /MUST NOT only recompute the hash/);
  assert.match(
    body,
    /reconfirm_required=true \+ invalidation_reason=seams-change \+ confirmed=false/,
  );
});

test("touch-scoped formatting anchors present (#2482)", () => {
  const simplification = read(".devpro/agent-rules/code-simplification.md");
  assert.match(simplification, /### Touch-scoped formatting（#2482）/);
  assert.match(simplification, /git diff --name-only/);
  assert.match(simplification, /禁止.*寬 glob|禁寬 glob/);

  const prePr = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
  assert.match(prePr, /Touch-scoped formatting（#2482）/);

  const briefing = read(".devpro/agent-rules/model-delegation-briefing.md");
  assert.match(briefing, /Touch-scoped formatting（#2482）/);

  const qa = read(".devpro/agent-rules/testing-and-qa.md");
  assert.match(qa, /touch-scoped/);
});
