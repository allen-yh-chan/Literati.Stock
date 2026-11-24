import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import {
  resolveHostSystemTmpdir,
  isDirectChildOfHostSystemTmpdir,
  NESTED_TMPDIR_LEAF_NAMES,
} from "../lib/host-system-tmpdir.mjs";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

describe("host-system-tmpdir (#2711)", () => {
  // Scenario: Nested Codex TMPDIR Still Passes Run Validation
  test("unwraps nested devpro-codex-tmpdir leaf", () => {
    const host = path.join(path.sep, "var", "folders", "xx", "T");
    const nested = path.join(host, "devpro-codex-tmpdir");
    assert.equal(
      resolveHostSystemTmpdir({ tmpdir: () => nested }),
      path.resolve(host),
    );
  });

  test("leaves ordinary host tmpdir unchanged", () => {
    const host = path.join(path.sep, "var", "folders", "xx", "T");
    assert.equal(
      resolveHostSystemTmpdir({ tmpdir: () => host }),
      path.resolve(host),
    );
  });

  // Scenario: Nested Codex TMPDIR Still Passes Run Validation
  test("render-under-nested matches run-under-host parent check", () => {
    const host = path.join(path.sep, "var", "folders", "xx", "T");
    const nested = path.join(host, "devpro-codex-tmpdir");
    // Render process saw nested TMPDIR; helper still places under host.
    const renderParent = resolveHostSystemTmpdir({ tmpdir: () => nested });
    const neutral = path.join(renderParent, "devpro-second-review-neutral-abc");
    // Run process saw host TMPDIR.
    assert.equal(
      isDirectChildOfHostSystemTmpdir(neutral, { tmpdir: () => host }),
      true,
    );
    // And still true if run also saw nested.
    assert.equal(
      isDirectChildOfHostSystemTmpdir(neutral, { tmpdir: () => nested }),
      true,
    );
  });

  test("NESTED leaf name is locked for Codex operator nesting", () => {
    assert.ok(NESTED_TMPDIR_LEAF_NAMES.includes("devpro-codex-tmpdir"));
  });

  // Scenario: Host Adapter Documents The Parity Rule
  test("cursor adapter documents host TMPDIR parity for render/run", () => {
    const adapter = readFileSync(
      repoPath(".devpro/agent-rules/platform-adapters/cursor.md"),
      "utf8",
    );
    assert.match(
      adapter,
      /host system temp|resolveHostSystemTmpdir|devpro-codex-tmpdir/,
      "cursor.md missing nested TMPDIR / host system temp guidance",
    );
    assert.match(
      adapter,
      /render-second-review-packet|run-second-reviewer-projection/,
      "cursor.md missing render/run pairing mention for TMPDIR",
    );
  });
});
