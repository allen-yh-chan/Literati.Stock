/**
 * tmp.test.mjs
 *
 * Integration tests for tests/lib/tmp.mjs temp-dir helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { makeTempDir, withTempDir } from "./tmp.mjs";

test("makeTempDir creates a unique directory", () => {
  const dir = makeTempDir("devpro-tmp-test-");
  try {
    assert.equal(existsSync(dir), true);
    assert.ok(path.basename(dir).startsWith("devpro-tmp-test-"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withTempDir yields the dir then cleans it up", async () => {
  let captured;
  await withTempDir(async (dir) => {
    captured = dir;
    assert.equal(existsSync(dir), true);
    assert.ok(path.basename(dir).startsWith("devpro-"));
  });
  assert.ok(captured);
  assert.equal(existsSync(captured), false);
});
