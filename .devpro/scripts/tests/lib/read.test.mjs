/**
 * read.test.mjs
 *
 * Unit tests for tests/lib/read.mjs and source-root path helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { REPO_ROOT } from "./repo-root.mjs";
import { SOURCE_ROOT, resolveSourceRoot, sourcePath } from "./source-root.mjs";
import { readRepoFile, readRepoFileIfExists, readSourceFile } from "./read.mjs";

test("readRepoFile of AGENTS.md starts with the expected heading", () => {
  assert.ok(readRepoFile("AGENTS.md").startsWith("# AI Agent"));
});

test("readRepoFileIfExists returns null for a missing path", () => {
  assert.equal(readRepoFileIfExists("definitely-not-a-file-xyzzy.md"), null);
});

test("SOURCE_ROOT and sourcePath resolve against this checkout", () => {
  assert.equal(SOURCE_ROOT, resolveSourceRoot(REPO_ROOT));
  assert.equal(sourcePath("AGENTS.md"), path.resolve(SOURCE_ROOT, "AGENTS.md"));
  assert.ok(readSourceFile("AGENTS.md").startsWith("# AI Agent"));
});
