import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib/sync-agent-rules-harness.mjs";

/**
 * Pin test (rules-flow spec: Rules Sync Leaves Consumer Claude Permissions
 * Unmodified): the source repo's own tracked `.claude/settings.json` must not
 * carry a top-level `permissions` key, so no permission grant is distributed
 * to consumers through sync. Adding one back is Ask First and must fail this
 * pin instead of passing silently.
 */
async function readSourceSettings() {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  return JSON.parse(await fs.readFile(settingsPath, "utf8"));
}

describe("Scenario: Source tracked settings carry no permissions", () => {
  it("Source tracked settings carry no permissions (no top-level permissions key)", async () => {
    const data = await readSourceSettings();

    assert.equal(
      Object.hasOwn(data, "permissions"),
      false,
      "source .claude/settings.json must not carry a top-level permissions key"
    );
  });

  it("Source tracked settings carry no permissions (hooks and statusLine are still present)", async () => {
    const data = await readSourceSettings();

    assert.ok(
      data.hooks && typeof data.hooks === "object" && Object.keys(data.hooks).length > 0,
      "source .claude/settings.json must still contain hooks"
    );
    assert.ok(data.statusLine, "source .claude/settings.json must still contain statusLine");
  });
});
