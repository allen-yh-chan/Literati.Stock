/**
 * Locks #2481+#2495: Step 3 named dispositions for receipt-authority deadlocks.
 * Unit-tier: reads file bytes / source text (no child_process). Behavioral proof for
 * null-predecessor → route=full is cited from core + existing classifier test title.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const DISPATCH =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const CHORE = ".devpro/agent-rules/chore-classification.md";
const HELPER = ".devpro/scripts/review-remediation-evidence.mjs";
const CORE = ".devpro/scripts/lib/review-remediation-evidence-core.mjs";
const BEHAVIORAL = ".devpro/scripts/tests/review-remediation-evidence.test.mjs";

const PROJECTIONS = [
  ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
  ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
];

function step3Slice(content) {
  const heading = "### 第三步：Six-Axis Review";
  const start = content.indexOf(heading);
  assert.ok(start >= 0, `missing ${heading}`);
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n### |\n## /);
  return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

function dispositionNeighborhood(slice, token) {
  const idx = slice.indexOf(token);
  assert.ok(idx >= 0, `missing disposition token ${token}`);
  // Look back far enough for the shared MUST NOT preamble; forward for the
  // full disposition sentence (classify-final / Review Summary / chain claim).
  const from = Math.max(0, idx - 200);
  const to = Math.min(slice.length, idx + token.length + 700);
  return slice.slice(from, to);
}

test("devpro:pre-pr Step 3 names missing-predecessor bootstrap disposition (#2481)", () => {
  const slice = step3Slice(readFileSync(repoPath(SKILL), "utf8"));
  const token = "receipt_authority_restart: missing_predecessor_seal";
  assert.match(slice, /receipt_authority_restart:\s*missing_predecessor_seal/);
  const near = dispositionNeighborhood(slice, token);
  assert.match(near, /previousReceiptRef:\s*null/);
  assert.match(near, /MUST NOT[^\n]{0,40}dispatch_id|禁自造\s*`?dispatch_id`?/);
  assert.match(near, /classify-final|seal-final/);
});

test("devpro:pre-pr Step 3 names chore-A receipt_authority_unavailable disposition (#2495)", () => {
  const slice = step3Slice(readFileSync(repoPath(SKILL), "utf8"));
  const token = "receipt_authority_unavailable: chore_a_no_openspec";
  assert.match(slice, /receipt_authority_unavailable:\s*chore_a_no_openspec/);
  const near = dispositionNeighborhood(slice, token);
  assert.match(near, /walkReceiptAuthorityChain/);
  assert.match(near, /mutable envelope \+ PR body Review Summary/);
  assert.match(near, /route=risk_shape_unavailable/);
});

test("chore-classification chore A invariants point at Step 3 disposition (#2495)", () => {
  const text = readFileSync(repoPath(CHORE), "utf8");
  const token = "receipt_authority_unavailable: chore_a_no_openspec";
  assert.match(text, /receipt_authority_unavailable:\s*chore_a_no_openspec/);
  const near = dispositionNeighborhood(text, token);
  assert.match(near, /devpro:pre-pr.*SKILL Step 3|SKILL Step 3/);
});

test("subagent-dispatch-blocks points at both receipt-authority dispositions", () => {
  const text = readFileSync(repoPath(DISPATCH), "utf8");
  assert.match(text, /receipt_authority_restart:\s*missing_predecessor_seal/);
  assert.match(text, /receipt_authority_unavailable:\s*chore_a_no_openspec/);
});

test("host skill projections stay byte-identical to SSOT skill", () => {
  const ssot = readFileSync(repoPath(SKILL));
  for (const rel of PROJECTIONS) {
    const projection = readFileSync(repoPath(rel));
    assert.equal(
      projection.equals(ssot),
      true,
      `${rel} must remain byte-identical to ${SKILL}`,
    );
  }
});

test("CLI help source documents null-ref bootstrap and chore-A disposition next-step", () => {
  const helpSource = readFileSync(repoPath(HELPER), "utf8");
  assert.match(helpSource, /previousReceiptRef:\s*null/);
  assert.match(helpSource, /missing_predecessor_seal/);
  assert.match(helpSource, /chore_a_no_openspec/);
  assert.match(helpSource, /MUST NOT invent/);
  assert.match(helpSource, /classify-final\/seal-final evaluate that new sealed lineage/);
});

test("null-predecessor initial_review path is cited in core and proven by existing behavioral test (#2481)", () => {
  const core = readFileSync(repoPath(CORE), "utf8");
  const nullBranch = core.match(
    /if \(input\.previousReceiptRef === null\) \{[\s\S]{0,800}?reason:\s*"initial_review"/,
  );
  assert.ok(nullBranch, "core must keep previousReceiptRef === null → initial_review dispatch path");
  assert.match(nullBranch[0], /route:\s*"full"/);
  assert.match(nullBranch[0], /roundNumber:\s*1/);

  const behavioral = readFileSync(repoPath(BEHAVIORAL), "utf8");
  assert.match(
    behavioral,
    /test\("initial classifier returns exact content-addressed dispatch context and role-only receipt round-trips"/,
  );
});
