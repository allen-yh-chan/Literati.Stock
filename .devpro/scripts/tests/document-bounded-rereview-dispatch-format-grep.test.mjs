/**
 * Locks #2391: devpro:pre-pr documents bounded rereview dispatch_id and manifest ref format.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const DISPATCH =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const CLI = ".devpro/scripts/review-remediation-evidence.mjs";

function step3Slice(content) {
  const heading = "### 第三步：Six-Axis Review";
  const start = content.indexOf(heading);
  assert.ok(start >= 0, "skill Step 3 missing");
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n### /);
  return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

test("devpro:pre-pr Step 3 documents 64-hex dispatch_id from classify-bounded", () => {
  const slice = step3Slice(readFileSync(repoPath(SKILL), "utf8"));
  assert.match(slice, /dispatch_id[^\n]*64-hex[^\n]*SHA256/i);
  assert.match(slice, /MUST NOT[^\n]*UUID/i);
  assert.match(slice, /classify-bounded/);
});

test("devpro:pre-pr Step 3 documents bounded non-null manifest refs", () => {
  const slice = step3Slice(readFileSync(repoPath(SKILL), "utf8"));
  assert.match(
    slice,
    /route=bounded[^\n]*repair_delta_manifest_ref[^\n]*dependency_closure_manifest_ref[^\n]*non-null/i,
  );
  assert.match(slice, /review-remediation-evidence\.mjs --help/);
  assert.doesNotMatch(slice, /首次 route 探測/);
  assert.match(slice, /先封 manifests 再跑 `classify-bounded`/);
});

test("subagent-dispatch-blocks documents dispatch_id digest and bounded manifest refs", () => {
  const source = readFileSync(repoPath(DISPATCH), "utf8");
  assert.match(source, /64-hex SHA256 logical dispatch digest/);
  assert.match(source, /non-null `repair_delta_manifest_ref` and `dependency_closure_manifest_ref`/);
  assert.match(source, /review-remediation-evidence\.mjs --help/);
  assert.doesNotMatch(source, /pre-route `classify-bounded` probes/);
});

test("CLI help still documents bounded non-null manifest requirement", () => {
  const source = readFileSync(repoPath(CLI), "utf8");
  assert.match(source, /Only route=bounded requires non-null sealed manifest refs/);
});
