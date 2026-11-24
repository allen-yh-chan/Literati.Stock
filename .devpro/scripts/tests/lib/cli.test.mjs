/**
 * cli.test.mjs
 *
 * Integration tests for tests/lib/cli.mjs runCli helper.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./cli.mjs";

test("runCli invokes recap-title-check with a valid title", () => {
  const result = runCli(".devpro/scripts/recap-title-check.mjs", [
    "--title",
    "[devpro-agent-rules] helper-smoke 2026-01-01",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: Recap title format verified/);
});
