/**
 * canonical-spec-section-spacing.test.mjs
 *
 * Guard for canonical spec section spacing (archive-tooling ADDED requirement):
 * a `### Requirement:` heading MUST be preceded by a blank line, except the
 * first requirement in a file directly following `## Requirements`.
 *
 * Scenario: Heading after a requirement body requires a blank line
 * Scenario: First requirement directly after the Requirements heading is legal
 *
 * Teeth: detector fixtures are permanent; the repo-wide pass asserts an
 * inventory floor so a silently shrunken scan corpus cannot fake a pass.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

/** Returns 1-based line numbers of `### Requirement:` headings lacking a separator. */
function findSpacingViolations(text) {
  const lines = String(text ?? "").split(/\r?\n/u);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^### Requirement:/u.test(lines[i])) continue;
    if (i === 0) {
      hits.push(i + 1);
      continue;
    }
    const prev = lines[i - 1].trim();
    if (prev === "" || prev === "## Requirements") continue;
    hits.push(i + 1);
  }
  return hits;
}

describe("canonical spec section spacing guard", () => {
  it("fixtures: dropped separator reds; blank line and first-after-Requirements pass", () => {
    // violation: heading glued to the previous requirement's final line
    assert.deepEqual(
      findSpacingViolations("## Requirements\n\n### Requirement: A\n\n- **AND** tail\n### Requirement: B"),
      [6]
    );
    // legal: first requirement directly after `## Requirements`
    assert.deepEqual(findSpacingViolations("## Requirements\n### Requirement: A\n\nbody"), []);
    // legal: blank line separator
    assert.deepEqual(findSpacingViolations("## Requirements\n\n### Requirement: A\n\nbody"), []);
    // CRLF input still parsed
    assert.deepEqual(
      findSpacingViolations("## Requirements\r\n\r\n### Requirement: A\r\n- **AND** tail\r\n### Requirement: B"),
      [5]
    );
  });

  it("all canonical specs keep a blank line before each ### Requirement (Scenario: Heading after a requirement body requires a blank line / Scenario: First requirement directly after the Requirements heading is legal)", () => {
    const files = execFileSync("git", ["ls-files", "-z", "--", "openspec/specs"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter((rel) => rel.endsWith("/spec.md"));
    assert.ok(files.length >= 30, `spec inventory unexpectedly small: ${files.length}`);
    const violations = [];
    for (const rel of files) {
      let text;
      try {
        text = readFileSync(repoPath(rel), "utf8");
      } catch (err) {
        violations.push(`${rel}: unreadable (${err.message})`);
        continue;
      }
      for (const line of findSpacingViolations(text)) {
        violations.push(`${rel}:${line}`);
      }
    }
    assert.deepEqual(violations, [], `canonical spec spacing violations:\n${violations.join("\n")}`);
  });
});
