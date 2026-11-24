/**
 * Locks Cursor second-review defaults: dispatch codex without identity remap stop,
 * but pr-sticky must not claim cross-model credit when primary is unproven.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const CARRIERS = [
  {
    label: "platform-adapters/cursor.md",
    path: ".devpro/agent-rules/platform-adapters/cursor.md",
    fragments: [
      "reviewer_family=codex",
      "cross-model-unverified",
      "design-gate default",
      "cursor-composer",
      "MUST NOT",
      "manual remap",
    ],
  },
  {
    label: "devpro:second-review SKILL Cursor subsection",
    // host routes moved to references/ (SKILL.md §Projection Routes keeps a routing table)
    path: ".devpro/agent-skills/devpro-reviews/second-review/references/cursor-and-other-hosts.md",
    fragments: [
      "cross-model-unverified",
      "reviewer_family=codex",
      "primary_family=unknown",
      "cursor-composer",
    ],
  },
  {
    label: "devpro:change design gate Cursor default",
    // design gate text moved to the full-rigor reference (SKILL.md keeps a pointer line)
    path: ".devpro/agent-skills/devpro-workflows/change/references/full-analysis-and-design.md",
    fragments: [
      "design-only",
      "identity: unknown",
      "provenance: unknown",
      "host_primary_unproven",
      "cross-model-unverified",
      "cursor-composer",
    ],
  },
  {
    label: ".cursor/agents/dp-second-reviewer.md",
    path: ".cursor/agents/dp-second-reviewer.md",
    fragments: [
      "cross-model-unverified",
      "primary_family=unknown",
      "identity: unknown",
      "provenance: unknown",
      "host_primary_unproven",
      "cursor-composer",
    ],
  },
  {
    label: ".opencode/agent/dp-second-reviewer.md",
    path: ".opencode/agent/dp-second-reviewer.md",
    fragments: [
      "cross-model-unverified",
      "primary_family=unknown",
      "identity: unknown",
      "provenance: unknown",
      "host_primary_unproven",
      "design-gate default",
    ],
  },
  {
    label: "platform-adapters/opencode.md design-gate",
    path: ".devpro/agent-rules/platform-adapters/opencode.md",
    fragments: [
      "design-gate default",
      "identity: unknown",
      "provenance: unknown",
      "host_primary_unproven",
      "cross-model-unverified",
    ],
  },
  {
    label: "devpro:cross-review SKILL Cursor line",
    path: ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md",
    fragments: [
      "cross-model-unverified",
      "primary_family=unknown",
    ],
  },
];

for (const carrier of CARRIERS) {
  test(`${carrier.label} documents Cursor dispatch vs cross-model credit split`, () => {
    const source = readFileSync(repoPath(carrier.path), "utf8");
    for (const fragment of carrier.fragments) {
      assert.ok(
        source.includes(fragment),
        `${carrier.label} missing required anchor: ${fragment}`,
      );
    }
  });
}

test("cursor.md forbids family-alias cross-model credit on unproven primary for pr-sticky", () => {
  const source = readFileSync(
    repoPath(".devpro/agent-rules/platform-adapters/cursor.md"),
    "utf8",
  );
  assert.match(
    source,
    /pr-sticky[\s\S]{0,400}primary_family=unknown[\s\S]{0,400}cross-model-unverified/,
    "pr-sticky unknown primary must use cross-model-unverified, not invented cross-model credit",
  );
  assert.match(
    source,
    /MUST NOT[\s\S]{0,120}merge-gate cross-model credit[\s\S]{0,120}family-alias/,
    "must forbid using family-alias for merge-gate cross-model credit when primary unproven",
  );
  assert.match(
    source,
    /design-gate default[\s\S]{0,500}identity: unknown[\s\S]{0,200}provenance: unknown/,
    "design-gate default must use host-unproven unknown/unknown, not fake claude alias",
  );
  assert.doesNotMatch(
    source,
    /design-gate default[\s\S]{0,400}identity: claude[\s\S]{0,80}family-alias/,
    "design-gate default must not force identity: claude + family-alias",
  );
});

test("opencode.md design-gate uses host-unproven unknown/unknown (not fake claude alias)", () => {
  const source = readFileSync(
    repoPath(".devpro/agent-rules/platform-adapters/opencode.md"),
    "utf8",
  );
  assert.match(
    source,
    /design-gate default[\s\S]{0,500}identity: unknown[\s\S]{0,200}provenance: unknown/,
    "opencode design-gate default must use host-unproven unknown/unknown",
  );
  assert.doesNotMatch(
    source,
    /design-gate default[\s\S]{0,400}identity: claude[\s\S]{0,80}family-alias/,
    "opencode design-gate must not force identity: claude + family-alias",
  );
});

test("packet prefix and verifySticky mechanically enforce cross-model-unverified for unknown primary", () => {
  const validate = readFileSync(
    repoPath(".devpro/scripts/validate-second-review-packet.mjs"),
    "utf8",
  );
  const runner = readFileSync(
    repoPath(".devpro/scripts/run-second-reviewer-projection.mjs"),
    "utf8",
  );
  const render = readFileSync(
    repoPath(".devpro/scripts/render-second-review-packet.mjs"),
    "utf8",
  );
  assert.match(
    validate,
    /CROSS_MODEL_UNVERIFIED_REASON_TOKEN\s*=\s*"cross-model-unverified"/,
    "validator MUST export the cross-model-unverified token constant",
  );
  assert.match(
    validate,
    /stickyReasonInjectedDisclosure/,
    "validator MUST own sticky reason disclosure helper used by prefix",
  );
  assert.match(
    validate,
    /primaryFamily:\s*options\.primaryFamily|primaryFamily:\s*data\.primary_family/,
    "prefix rebuild path MUST thread primary_family into disclosure",
  );
  assert.match(
    render,
    /primaryFamily:\s*data\.primary_family/,
    "renderer MUST pass primary_family into packet static prefix options",
  );
  assert.match(
    runner,
    /sticky_cross_model_unverified_provenance_missing/,
    "verifySticky MUST fail closed when unknown-primary sticky lacks the token",
  );
  assert.match(
    runner,
    /stickyReasonRequiresCrossModelUnverified/,
    "runner MUST import the cross-model-unverified reason predicate",
  );
});
