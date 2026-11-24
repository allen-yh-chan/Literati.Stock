import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

// Mirrors agents-md-index-mapping.test.mjs, but for README.md's 模組總覽 table:
// the table must stay in sync with .devpro/agent-rules/*.md as rule files are
// added/removed (e.g. de-bundle splits). PR #1175 had to retro-fix 16 leaves
// that drifted out of the table with no mechanical backstop; this test is that
// backstop, run by the local `node --test` suite that /dp:pre-pr Step 1 gates on.

const readmePath = repoPath("README.md");
const rulesDir = repoPath(".devpro/agent-rules");

// Top-level leaves intentionally absent from the 模組總覽 table. Empty after
// PR #1175 (all present). Add a leaf here with an inline reason if a future
// change deliberately keeps it out of the table.
const EXEMPT_TABLE_LEAVES = new Set([]);

// platform-adapters/*.md is covered by a single glob row, not per-leaf rows.
const GLOB_COVERED_SUBDIR = "platform-adapters";

async function read(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function rootRuleFiles() {
  const entries = await fs.readdir(rulesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

// Extract the 模組總覽 table section (heading until the next horizontal rule).
function extractModuleTableSection(markdown) {
  const section = markdown.match(/## 模組總覽[\s\S]*?\n---/);
  assert.ok(section, "README.md must contain a 模組總覽 section");
  return section[0];
}

// Distinct rule-leaf basenames linked in the table, keyed off the link TARGET
// `(.devpro/agent-rules/<leaf>.md)` rather than the display text — so merged
// entries like `[multi-agent-handoff.md §Vocabulary](.devpro/agent-rules/multi-agent-handoff.md)`
// resolve to their real leaf, and the glob row (which targets the directory,
// not a .md file) is naturally excluded.
//
// The leaf class is `[^/)]+` (any basename char except a path separator or the
// closing paren) so it matches whatever rootRuleFiles() accepts — including a
// future non-kebab-case leaf (underscore/uppercase/dot). Excluding `/` keeps
// subdir links like `platform-adapters/foo.md` out (covered by the glob row).
function linkedTableLeaves(sectionMarkdown) {
  const leaves = new Set();
  const re = /\]\(\.devpro\/agent-rules\/([^/)]+\.md)\)/g;
  for (const match of sectionMarkdown.matchAll(re)) {
    leaves.add(match[1]);
  }
  return leaves;
}

describe("README 模組總覽 table coverage", () => {
  it("covers every top-level .devpro/agent-rules/*.md leaf (no missing rows)", async () => {
    const [readme, rootFiles] = await Promise.all([read(readmePath), rootRuleFiles()]);
    const linked = linkedTableLeaves(extractModuleTableSection(readme));

    const missing = rootFiles.filter(
      (file) => !EXEMPT_TABLE_LEAVES.has(file) && !linked.has(file)
    );

    assert.deepEqual(
      missing,
      [],
      `README 模組總覽 table is missing rows for rule leaves: ${missing.join(", ")}. ` +
        `Add a linked row, or add the leaf to EXEMPT_TABLE_LEAVES with a reason.`
    );
  });

  it("links only existing rule leaves (no broken/phantom refs)", async () => {
    const [readme, rootFiles] = await Promise.all([read(readmePath), rootRuleFiles()]);
    const rootFileSet = new Set(rootFiles);
    const linked = linkedTableLeaves(extractModuleTableSection(readme));

    const phantoms = [...linked].filter((leaf) => !rootFileSet.has(leaf)).sort();

    assert.deepEqual(
      phantoms,
      [],
      `README 模組總覽 table links non-existent rule leaves: ${phantoms.join(", ")}`
    );
  });

  it("keeps the platform-adapters glob row instead of per-leaf rows", async () => {
    const readme = await read(readmePath);
    const section = extractModuleTableSection(readme);

    // The subdir is covered by one glob row; assert it is referenced and that no
    // individual platform-adapters/*.md leaf was inlined as its own row.
    assert.match(
      section,
      /platform-adapters\/\*\.md/,
      "README 模組總覽 table must keep the platform-adapters/*.md glob row"
    );
    assert.doesNotMatch(
      section,
      new RegExp(`\\]\\(\\.devpro/agent-rules/${GLOB_COVERED_SUBDIR}/[a-z0-9-]+\\.md\\)`),
      `README 模組總覽 table must not link individual ${GLOB_COVERED_SUBDIR}/*.md leaves (covered by the glob row)`
    );
  });
});
