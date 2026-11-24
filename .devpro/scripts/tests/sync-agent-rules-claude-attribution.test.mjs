import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  repoRoot,
  run,
  withConsumerRepo,
  withSlimSyncSource,
} from "./lib/sync-agent-rules-harness.mjs";

/**
 * sync-agent-rules-claude-attribution.test.mjs
 *
 * rules-flow spec — Rules Sync Writes Source Claude Attribution To Consumer.
 *
 * `attribution` is source-owned like `statusLine`: a plain-object source value
 * replaces the consumer's, anything else leaves the consumer's untouched. The
 * behavior is exercised through real `--sync` subprocess spawns against a temp
 * source + temp consumer repo, reusing the shared harness. Each test rewrites
 * its OWN fresh withSlimSyncSource() sourceRoot's .claude/settings.json; the
 * shared fixture itself is never modified.
 *
 * `--uninstall` mirrors `statusLine`: it removes the consumer's `attribution`
 * only while it is still identical to the source's plain-object value, in both
 * the dry-run plan and the apply path (rules-flow spec; canonical
 * consumer-adoption-tooling "Uninstall Reverse Removal" category C).
 */

const SOURCE_ATTRIBUTION = { commit: "", pr: "" };
const CONSUMER_ATTRIBUTION = { commit: "consumer commit trailer", pr: "consumer pr line" };
const COMPLETION_LINE =
  "Synchronized .claude/settings.json (hooks + model + statusLine + attribution)";
const REVERSE_LINE =
  "Reversed .claude/settings.json (hooks + model + statusLine + attribution)";
const PLAN_ITEM = ".claude/settings.json attribution";

/** Set (or, when `attribution` is undefined, drop) the source attribution key. */
async function overwriteSourceAttribution(sourceRoot, attribution) {
  const settingsPath = path.join(sourceRoot, ".claude", "settings.json");
  const next = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  delete next.attribution;
  if (attribution !== undefined) next.attribution = attribution;
  await fs.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
}

async function writeConsumerSettings(consumerRoot, data) {
  const settingsPath = path.join(consumerRoot, ".claude", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(data, null, 2)}\n`);
}

function consumerSettingsPath(consumerRoot) {
  return path.join(consumerRoot, ".claude", "settings.json");
}

async function readConsumerSettings(consumerRoot) {
  return JSON.parse(await fs.readFile(consumerSettingsPath(consumerRoot), "utf8"));
}

/**
 * Seed the source attribution and consumer settings, run --sync once, and hand
 * the harness context to `fn`. `consumerSettings` of undefined leaves the
 * consumer without a settings file.
 */
async function withSyncedAttribution({ sourceAttribution, consumerSettings }, fn) {
  await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
    await overwriteSourceAttribution(slimSourceRoot, sourceAttribution);
    await withConsumerRepo(async (local) => {
      if (consumerSettings !== undefined) {
        await writeConsumerSettings(local.tmpDir, consumerSettings);
      }
      const sync = () =>
        run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
      // --uninstall stages deletions with `git rm --cached`, so the consumer
      // needs a repository (createConsumerRepo does not init one).
      const uninstall = (flags) => {
        spawnSync("git", ["init", "-q", "-b", "main"], { cwd: local.tmpDir, encoding: "utf8" });
        return run(local.syncScript, `--uninstall ${flags}`, {
          cwd: local.tmpDir,
          testSourceRoot: slimSourceRoot,
        });
      };
      await fn({ local, sync, uninstall });
    });
  });
}

describe("Rules Sync Writes Source Claude Attribution To Consumer", () => {
  describe("Scenario: Sync copies the source attribution into a consumer that has none", () => {
    it("Sync copies the source attribution into a consumer that has none (consumer attribution deep-equals the source's)", async () => {
      await withSyncedAttribution(
        { sourceAttribution: SOURCE_ATTRIBUTION, consumerSettings: { model: "consumer-model" } },
        async ({ local, sync }) => {
          const { exitCode, stderr } = sync();
          assert.equal(exitCode, 0, stderr);

          const data = await readConsumerSettings(local.tmpDir);
          assert.deepEqual(data.attribution, SOURCE_ATTRIBUTION);
        }
      );
    });
  });

  describe("Scenario: Sync replaces a differing consumer attribution", () => {
    it("Sync replaces a differing consumer attribution (consumer attribution deep-equals the source's)", async () => {
      await withSyncedAttribution(
        {
          sourceAttribution: SOURCE_ATTRIBUTION,
          consumerSettings: { attribution: CONSUMER_ATTRIBUTION },
        },
        async ({ local, sync }) => {
          const { exitCode, stderr } = sync();
          assert.equal(exitCode, 0, stderr);

          const data = await readConsumerSettings(local.tmpDir);
          assert.deepEqual(data.attribution, SOURCE_ATTRIBUTION);
        }
      );
    });
  });

  describe("Scenario: Source without attribution leaves the consumer attribution untouched", () => {
    const sourceCases = [
      { label: "source has no attribution key", sourceAttribution: undefined },
      { label: "source attribution is null", sourceAttribution: null },
      { label: "source attribution is a string", sourceAttribution: "not-an-object" },
      { label: "source attribution is an array", sourceAttribution: ["not", "an", "object"] },
    ];

    for (const { label, sourceAttribution } of sourceCases) {
      it(`Source without attribution leaves the consumer attribution untouched (${label}: consumer attribution deep-equals its value before the run)`, async () => {
        await withSyncedAttribution(
          { sourceAttribution, consumerSettings: { attribution: CONSUMER_ATTRIBUTION } },
          async ({ local, sync }) => {
            const { exitCode, stderr } = sync();
            assert.equal(exitCode, 0, stderr);

            const data = await readConsumerSettings(local.tmpDir);
            assert.deepEqual(data.attribution, CONSUMER_ATTRIBUTION);
          }
        );
      });
    }
  });

  describe("Scenario: Second sync is byte-stable", () => {
    it("Second sync is byte-stable (consumer settings bytes identical before and after the second run)", async () => {
      await withSyncedAttribution(
        { sourceAttribution: SOURCE_ATTRIBUTION, consumerSettings: { attribution: CONSUMER_ATTRIBUTION } },
        async ({ local, sync }) => {
          const first = sync();
          assert.equal(first.exitCode, 0, first.stderr);
          // Precondition of the scenario: the first run already wrote the source attribution.
          const afterFirst = await readConsumerSettings(local.tmpDir);
          assert.deepEqual(afterFirst.attribution, SOURCE_ATTRIBUTION);
          const firstBytes = await fs.readFile(consumerSettingsPath(local.tmpDir));

          const second = sync();
          assert.equal(second.exitCode, 0, second.stderr);
          const secondBytes = await fs.readFile(consumerSettingsPath(local.tmpDir));

          assert.ok(
            firstBytes.equals(secondBytes),
            "second --sync must not rewrite settings.json bytes when nothing is left to change"
          );
        }
      );
    });
  });

  describe("Scenario: Completion message names attribution", () => {
    it("Completion message names attribution (stdout contains the exact completion line)", async () => {
      await withSyncedAttribution(
        { sourceAttribution: SOURCE_ATTRIBUTION, consumerSettings: undefined },
        async ({ sync }) => {
          const { exitCode, stdout, stderr } = sync();
          assert.equal(exitCode, 0, stderr);

          const lines = stdout.split(/\r?\n/);
          assert.ok(
            lines.includes(COMPLETION_LINE),
            `stdout must contain the exact line "${COMPLETION_LINE}"`
          );
        }
      );
    });
  });

  describe("Scenario: Uninstall removes a synced attribution that still equals the source's", () => {
    it("Uninstall dry-run lists attribution in the plan and changes nothing (settings bytes identical)", async () => {
      await withSyncedAttribution(
        {
          sourceAttribution: SOURCE_ATTRIBUTION,
          consumerSettings: { attribution: CONSUMER_ATTRIBUTION },
        },
        async ({ local, sync, uninstall }) => {
          const synced = sync();
          assert.equal(synced.exitCode, 0, synced.stderr);
          const before = await fs.readFile(consumerSettingsPath(local.tmpDir));

          const { exitCode, stdout, stderr } = uninstall("--dry-run");
          assert.equal(exitCode, 0, stderr);
          assert.ok(stdout.includes(PLAN_ITEM), `dry-run plan must list "${PLAN_ITEM}"; stdout=${stdout}`);

          const after = await fs.readFile(consumerSettingsPath(local.tmpDir));
          assert.ok(before.equals(after), "dry-run must not modify settings.json");
        }
      );
    });

    it("Uninstall apply removes the attribution, keeps consumer-owned keys and permissions, and prints the reverse completion line", async () => {
      const consumerPermissions = { allow: ["Bash(keep-me:*)"], deny: ["Bash(never:*)"] };
      await withSyncedAttribution(
        {
          sourceAttribution: SOURCE_ATTRIBUTION,
          consumerSettings: {
            attribution: CONSUMER_ATTRIBUTION,
            consumerLocalKey: { foo: "bar" },
            permissions: consumerPermissions,
          },
        },
        async ({ local, sync, uninstall }) => {
          const synced = sync();
          assert.equal(synced.exitCode, 0, synced.stderr);
          // Precondition: sync wrote the source value, so the consumer's equals it.
          assert.deepEqual((await readConsumerSettings(local.tmpDir)).attribution, SOURCE_ATTRIBUTION);

          const { exitCode, stdout, stderr } = uninstall("--yes");
          assert.equal(exitCode, 0, stderr);

          const data = await readConsumerSettings(local.tmpDir);
          assert.equal(Object.hasOwn(data, "attribution"), false, "synced attribution must be removed");
          assert.deepEqual(data.consumerLocalKey, { foo: "bar" });
          assert.deepEqual(data.permissions, consumerPermissions);
          assert.ok(
            stdout.split(/\r?\n/).includes(REVERSE_LINE),
            `stdout must contain the exact line "${REVERSE_LINE}"`
          );
        }
      );
    });
  });

  describe("Scenario: Uninstall leaves a consumer attribution that differs from the source's", () => {
    it("Uninstall leaves a consumer attribution changed after sync (plan omits it, value deep-equals its value before the run)", async () => {
      await withSyncedAttribution(
        { sourceAttribution: SOURCE_ATTRIBUTION, consumerSettings: {} },
        async ({ local, sync, uninstall }) => {
          const synced = sync();
          assert.equal(synced.exitCode, 0, synced.stderr);
          const customized = { ...(await readConsumerSettings(local.tmpDir)), attribution: CONSUMER_ATTRIBUTION };
          await writeConsumerSettings(local.tmpDir, customized);

          const dry = uninstall("--dry-run");
          assert.equal(dry.exitCode, 0, dry.stderr);
          assert.equal(dry.stdout.includes(PLAN_ITEM), false, "plan must not list a differing attribution");

          const applied = uninstall("--yes");
          assert.equal(applied.exitCode, 0, applied.stderr);
          assert.deepEqual((await readConsumerSettings(local.tmpDir)).attribution, CONSUMER_ATTRIBUTION);
        }
      );
    });

    const nonObjectCases = [
      { label: "source and consumer attribution are both null", value: null },
      { label: "source and consumer attribution are both the same string", value: "not-an-object" },
      { label: "source and consumer attribution are both the same array", value: ["not", "an", "object"] },
    ];

    for (const { label, value } of nonObjectCases) {
      it(`Uninstall leaves a consumer attribution when the source value is not a plain object (${label}: plan omits it, value deep-equals its value before the run)`, async () => {
        await withSyncedAttribution(
          { sourceAttribution: value, consumerSettings: { attribution: value } },
          async ({ local, uninstall }) => {
            // No sync run: sync leaves a non-plain-object source alone, and the
            // consumer already carries a value that serializes the same as the source's.
            const dry = uninstall("--dry-run");
            assert.equal(dry.exitCode, 0, dry.stderr);
            assert.equal(dry.stdout.includes(PLAN_ITEM), false, "plan must not list it");

            const applied = uninstall("--yes");
            assert.equal(applied.exitCode, 0, applied.stderr);
            assert.deepEqual((await readConsumerSettings(local.tmpDir)).attribution, value);
          }
        );
      });
    }
  });

  describe("Scenario: Source tracked settings hide the Claude Code attribution", () => {
    it("Source tracked settings hide the Claude Code attribution (attribution deep-equals { commit: \"\", pr: \"\" })", async () => {
      const settingsPath = path.join(repoRoot, ".claude", "settings.json");
      const data = JSON.parse(await fs.readFile(settingsPath, "utf8"));

      assert.deepEqual(data.attribution, { commit: "", pr: "" });
    });
  });
});
