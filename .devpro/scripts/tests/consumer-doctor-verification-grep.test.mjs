/**
 * consumer-doctor-verification-grep.test.mjs
 *
 * consumer-doctor's Verification block is what a consumer repo is told to run.
 * `lint-agent-skills.mjs` only accepts the single `devpro` entry under a
 * discovery root, so it rejects a consumer's own skill entries; a consumer must
 * run the sync parity check instead. This guard keeps the two audiences apart:
 * the lint command sits under the source-repo label only, and the consumer
 * section carries `sync-agent-rules.mjs --check`.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SKILL_PATH = ".devpro/agent-skills/consumer/consumer-doctor/SKILL.md";

/** The command lines of the fenced bash block under `## Verification`, grouped by audience label. */
function verificationSections(markdown) {
  const heading = markdown.split("\n## Verification")[1];
  if (heading === undefined) throw new Error("consumer-doctor SKILL.md has no `## Verification` section");
  const fence = /```bash\n([\s\S]*?)```/.exec(heading);
  if (!fence) throw new Error("`## Verification` has no fenced bash block");
  const sections = { source: [], consumer: [], shared: [] };
  let current = "shared";
  for (const line of fence[1].split("\n")) {
    if (/^#\s*source repo/.test(line)) current = "source";
    else if (/^#\s*consumer repo/.test(line)) current = "consumer";
    else if (/^#\s*兩者共用/.test(line)) current = "shared";
    else if (line.trim() !== "" && !line.startsWith("#")) sections[current].push(line.trim());
  }
  return sections;
}

const sections = verificationSections(readFileSync(repoPath(SKILL_PATH), "utf8"));

test("the lint command is labelled source-repo only and never offered to a consumer", () => {
  assert.deepEqual(sections.source, ["node .devpro/scripts/lint-agent-skills.mjs"]);
  for (const audience of ["consumer", "shared"]) {
    assert.equal(
      sections[audience].some((line) => line.includes("lint-agent-skills")),
      false,
      `the ${audience} section must not run lint-agent-skills (it rejects consumer-owned skill entries)`,
    );
  }
});

test("the consumer section runs the sync parity check", () => {
  assert.deepEqual(sections.consumer, ["node .devpro/scripts/sync-agent-rules.mjs --check"]);
});

test("the shared section keeps the adoption matrix and both smoke commands", () => {
  assert.deepEqual(sections.shared, [
    "node .devpro/scripts/consumer-adoption-matrix.mjs --check",
    "node .devpro/scripts/devpro-doctor.mjs --consumer-smoke",
    "node .devpro/scripts/test-consumer-smoke.mjs",
  ]);
});

test("verificationSections fails loudly on a missing section or fence instead of returning empty groups", () => {
  assert.throws(() => verificationSections("# x\n"), /no `## Verification` section/);
  assert.throws(() => verificationSections("# x\n\n## Verification\n\nno fence\n"), /no fenced bash block/);
});
