/**
 * Repository-wide version-metadata marker scan. This belongs to integration because it invokes git.
 *
 * [Req: R3, R4]
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// ---------------------------------------------------------------------------
// S3: version-metadata-files marker SSOT — exactly one, 6 items, unique repo-wide.
// ---------------------------------------------------------------------------
const MARKER_OPEN = "<!-- version-metadata-files:";
const MARKER_CLOSE = " -->";
const START_MARKER = `${MARKER_OPEN}start${MARKER_CLOSE}`;
const END_MARKER = `${MARKER_OPEN}end${MARKER_CLOSE}`;
const EXPECTED_PATTERNS = new Set([
  "Directory.Build.props",
  "*.csproj",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "AGENTS.md",
]);

test("S3: version-metadata-files marker exists exactly once, repo-wide, in release-sit-uat-pat-prod.md", () => {
  const scanned = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT })
    .toString("utf8")
    .split("\0")
    .filter((relativePath) => relativePath && !relativePath.startsWith("openspec/changes/archive/"));
  const hits = [];
  for (const relativePath of scanned) {
    const filePath = join(REPO_ROOT, relativePath);
    const text = lstatSync(filePath).isSymbolicLink() ? readlinkSync(filePath) : readFileSync(filePath, "utf8");
    let searchableText = text;
    if (relativePath === ".devpro/scripts/hotfix-carrier-verify.mjs") {
      // The verifier must name both tokens to parse their SSOT; these two code
      // constants are references, not extra marker placements. Keep scanning
      // the rest of this tracked file so any additional occurrence is counted.
      for (const declaration of [
        `const MARKER_START = ${JSON.stringify(START_MARKER)};`,
        `const MARKER_END = ${JSON.stringify(END_MARKER)};`,
      ]) {
        assert.ok(searchableText.includes(declaration), `verifier marker reference drifted: ${declaration}`);
        searchableText = searchableText.replace(declaration, "");
      }
    }
    const startCount = (searchableText.match(new RegExp(START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    if (startCount > 0) hits.push({ filePath, relativePath, text: searchableText, startCount });
  }

  assert.equal(hits.length, 1, `version-metadata-files:start must exist in exactly one live tracked file, found in: ${hits.map((h) => h.relativePath).join(", ")}`);
  const [{ filePath, text, startCount }] = hits;
  assert.ok(filePath.endsWith("release-sit-uat-pat-prod.md"), `marker must live in release-sit-uat-pat-prod.md, found in ${filePath}`);
  assert.equal(startCount, 1, "start marker must appear exactly once");

  const endCount = (text.match(new RegExp(END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  assert.equal(endCount, 1, "end marker must appear exactly once");

  const startIdx = text.indexOf(START_MARKER);
  const endIdx = text.indexOf(END_MARKER);
  assert.ok(startIdx >= 0 && endIdx > startIdx, "start marker must precede end marker");

  const body = text.slice(startIdx + START_MARKER.length, endIdx);
  const items = [...body.matchAll(/^- \x60([^\x60]+)\x60/gm)].map((m) => m[1]);
  const itemSet = new Set(items);

  const missing = [...EXPECTED_PATTERNS].filter((p) => !itemSet.has(p));
  const extra = [...itemSet].filter((p) => !EXPECTED_PATTERNS.has(p));
  assert.deepEqual(missing, [], `version-metadata-files marker missing patterns: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `version-metadata-files marker has unexpected extra patterns: ${extra.join(", ")}`);
  assert.equal(items.length, 6, `version-metadata-files marker must have exactly 6 items, got ${items.length}`);

  const agentsLine = body.split("\n").find((l) => l.includes("`AGENTS.md`"));
  assert.ok(agentsLine && agentsLine.includes("source-only"), "AGENTS.md item must be marked source-only");
});
