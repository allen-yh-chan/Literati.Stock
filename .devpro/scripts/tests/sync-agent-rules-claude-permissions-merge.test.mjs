import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  run,
  withConsumerRepo,
  withSlimSyncSource,
} from "./lib/sync-agent-rules-harness.mjs";

/**
 * sync-agent-rules-claude-permissions-merge.test.mjs
 *
 * rules-flow spec — Rules Sync Leaves Consumer Claude Permissions Unmodified.
 *
 * Sync never reads or writes the consumer's `permissions`, whatever the
 * source carries. The behavior is exercised only through real `--sync`
 * subprocess spawns against a temp source + temp consumer repo, reusing
 * withSlimSyncSource()/withConsumerRepo()/run() from the shared harness. To
 * make "untouched" meaningful, each test overwrites its OWN fresh
 * withSlimSyncSource()-provided sourceRoot's .claude/settings.json so the
 * source still carries `permissions.allow` (a source that grants nothing could
 * not tell "ignored" from "nothing to merge"). The shared fixture's
 * createSlimSyncSource() itself is never modified, so every other test file
 * sharing it stays byte-identical.
 *
 * The contract guarantees only the PARSED value of `permissions`; sync
 * rewrites the whole file whenever another merged field changes, so
 * assertions deep-equal parsed values and never compare permission bytes.
 */

const SOURCE_ALLOW_ENTRY = "Bash(source-granted-cmd:*)";
const SOURCE_MODEL = "test-model";
const SOURCE_STATUS_LINE = { type: "command", command: "echo ok" };

async function overwriteSourcePermissions(sourceRoot, permissions) {
  const settingsPath = path.join(sourceRoot, ".claude", "settings.json");
  const existing = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const next = { ...existing, permissions };
  await fs.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
}

async function writeConsumerSettings(consumerRoot, data) {
  const settingsPath = path.join(consumerRoot, ".claude", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(data, null, 2)}\n`);
}

async function readConsumerSettings(consumerRoot) {
  const settingsPath = path.join(consumerRoot, ".claude", "settings.json");
  return JSON.parse(await fs.readFile(settingsPath, "utf8"));
}

/** Seed the consumer, run --sync against a source that carries permissions.allow, return result + parsed after. */
async function syncWithConsumerSettings(consumerSettings, fn) {
  await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
    await overwriteSourcePermissions(slimSourceRoot, { allow: [SOURCE_ALLOW_ENTRY] });
    await withConsumerRepo(async (local) => {
      await writeConsumerSettings(local.tmpDir, consumerSettings);
      const result = run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        testSourceRoot: slimSourceRoot,
      });
      const after = result.exitCode === 0 ? await readConsumerSettings(local.tmpDir) : null;
      await fn({ result, after });
    });
  });
}

function assertMergedNormally(after) {
  assert.ok(
    after.hooks !== undefined && typeof after.hooks === "object",
    "hooks must still merge normally in the same run"
  );
  assert.equal(after.model, SOURCE_MODEL, "model must still merge normally in the same run");
  assert.deepEqual(
    after.statusLine,
    SOURCE_STATUS_LINE,
    "statusLine must still merge normally in the same run"
  );
}

describe("Rules Sync Leaves Consumer Claude Permissions Unmodified", () => {
  describe("Scenario: Consumer permissions with allow, deny, ask and defaultMode are preserved", () => {
    const consumerPermissions = {
      allow: ["Bash(existing-cmd:*)", "Bash(existing-cmd:*)"],
      deny: ["Bash(rm -rf:*)"],
      ask: ["Bash(git push:*)"],
      defaultMode: "acceptEdits",
    };

    it("Consumer permissions with allow, deny, ask and defaultMode are preserved (parsed value deep-equal before and after)", async () => {
      await syncWithConsumerSettings(
        { model: "consumer-model", permissions: consumerPermissions },
        async ({ result, after }) => {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.deepEqual(after.permissions, consumerPermissions);
        }
      );
    });

    it("Consumer permissions with allow, deny, ask and defaultMode are preserved (hooks/model/statusLine still merge normally in the same run)", async () => {
      await syncWithConsumerSettings(
        { model: "consumer-model", permissions: consumerPermissions },
        async ({ result, after }) => {
          assert.equal(result.exitCode, 0, result.stderr);
          assertMergedNormally(after);
        }
      );
    });
  });

  describe("Scenario: Consumer without permissions does not gain one", () => {
    it("Consumer without permissions does not gain one (no top-level permissions key afterward)", async () => {
      await syncWithConsumerSettings(
        { model: "consumer-model", hooks: {} },
        async ({ result, after }) => {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(
            Object.hasOwn(after, "permissions"),
            false,
            "sync must not create a permissions key on a consumer that has none"
          );
        }
      );
    });
  });

  describe("Scenario: Malformed consumer permissions value is preserved", () => {
    const malformedCases = [
      {
        label: "permissions is a non-object value (string)",
        permissions: "not-an-object",
      },
      {
        label: "permissions.allow is present but not an array",
        permissions: { allow: "not-an-array", deny: ["Bash(rm -rf:*)"] },
      },
    ];

    for (const { label, permissions } of malformedCases) {
      it(`Malformed consumer permissions value is preserved (${label}: parsed value deep-equal before and after)`, async () => {
        await syncWithConsumerSettings({ permissions }, async ({ result, after }) => {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.deepEqual(after.permissions, permissions);
        });
      });

      it(`Malformed consumer permissions value is preserved (${label}: sync exits successfully and still merges hooks/model/statusLine)`, async () => {
        await syncWithConsumerSettings({ permissions }, async ({ result, after }) => {
          assert.equal(result.exitCode, 0, result.stderr);
          assertMergedNormally(after);
        });
      });
    }
  });
});
