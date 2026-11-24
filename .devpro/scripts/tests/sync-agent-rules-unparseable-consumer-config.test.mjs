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
 * A consumer's `.claude/settings.json`, `.codex/hooks.json` or `.cursor/hooks.json`
 * that exists but cannot be parsed must never be replaced by a merge result built
 * from an empty object: that silently deletes the consumer's own permissions and
 * hooks. `--sync` fails closed instead (names the file, leaves its bytes alone);
 * a missing or empty file still means "nothing to preserve".
 *
 * The merge helpers are not exported, so every case drives a real `--sync`
 * subprocess against a slim source and a temp consumer repo (same convention as
 * sync-agent-rules-claude-permissions-merge.test.mjs).
 */

const UNPARSEABLE_TRUNCATED = '{\n  "permissions": { "allow": ["Bash(keep-me:*)"] },\n  "hooks": {';

const CONFIGS = [
  { relPath: path.join(".claude", "settings.json"), label: ".claude/settings.json" },
  { relPath: path.join(".codex", "hooks.json"), label: ".codex/hooks.json" },
  { relPath: path.join(".cursor", "hooks.json"), label: ".cursor/hooks.json" },
];

async function writeRaw(consumerRoot, relPath, content) {
  const target = path.join(consumerRoot, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

describe("rules sync does not overwrite an unparseable consumer config", () => {
  for (const { relPath, label } of CONFIGS) {
    it(`check and uninstall reject invalid ${label} before changing consumer files`, async () => {
      await withSlimSyncSource(async ({ sourceRoot }) => {
        await withConsumerRepo(async (local) => {
          const synced = run(local.syncScript, "--sync", {
            cwd: local.tmpDir,
            testSourceRoot: sourceRoot,
          });
          assert.equal(synced.exitCode, 0, synced.stderr);
          const agentsPath = path.join(local.tmpDir, "AGENTS.md");
          const agentsBefore = await fs.readFile(agentsPath, "utf8");
          const scriptBefore = await fs.readFile(local.syncScript, "utf8");
          for (const [args, command] of [
            ["--check", "--check"],
            ["--uninstall --dry-run", "--uninstall"],
            ["--uninstall --yes", "--uninstall"],
          ]) {
            for (const [raw, diagnostic] of [
              [UNPARSEABLE_TRUNCATED, /Invalid JSON/i],
              ['["not", "an", "object"]\n', /not a JSON object/i],
            ]) {
              const target = await writeRaw(local.tmpDir, relPath, raw);
              const result = run(local.syncScript, args, {
                cwd: local.tmpDir,
                testSourceRoot: sourceRoot,
              });
              assert.notEqual(result.exitCode, 0, `${args} must reject ${label}`);
              assert.ok(result.stderr.includes(label), result.stderr);
              assert.match(result.stderr, diagnostic);
              assert.ok(result.stderr.includes(`re-run ${command} with the same options`), result.stderr);
              assert.equal(await fs.readFile(target, "utf8"), raw);
              assert.equal(await fs.readFile(agentsPath, "utf8"), agentsBefore);
              assert.equal(await fs.readFile(local.syncScript, "utf8"), scriptBefore);
            }
          }
        });
      });
    });
  }

  for (const { relPath, label } of CONFIGS) {
    it(`fails closed on truncated JSON in ${label} and leaves its bytes untouched`, async () => {
      await withSlimSyncSource(async ({ sourceRoot }) => {
        await withConsumerRepo(async (local) => {
          const target = await writeRaw(local.tmpDir, relPath, UNPARSEABLE_TRUNCATED);

          const { exitCode, stderr } = run(local.syncScript, "--sync", {
            cwd: local.tmpDir,
            testSourceRoot: sourceRoot,
          });

          assert.notEqual(exitCode, 0, "sync must not report success");
          assert.ok(stderr.includes(label), `stderr must name ${label}: ${stderr}`);
          assert.ok(/Invalid JSON/i.test(stderr), `stderr must say the JSON is invalid: ${stderr}`);
          assert.equal(
            await fs.readFile(target, "utf8"),
            UNPARSEABLE_TRUNCATED,
            "the consumer's file must stay byte-identical"
          );
        });
      });
    });

    it(`fails closed on a non-object JSON value in ${label}`, async () => {
      await withSlimSyncSource(async ({ sourceRoot }) => {
        await withConsumerRepo(async (local) => {
          const target = await writeRaw(local.tmpDir, relPath, '["not", "an", "object"]\n');

          const { exitCode, stderr } = run(local.syncScript, "--sync", {
            cwd: local.tmpDir,
            testSourceRoot: sourceRoot,
          });

          assert.notEqual(exitCode, 0);
          assert.ok(stderr.includes(label), stderr);
          assert.ok(/not a JSON object/i.test(stderr), stderr);
          assert.equal(await fs.readFile(target, "utf8"), '["not", "an", "object"]\n');
        });
      });
    });

    it(`still treats an empty ${label} as nothing to preserve`, async () => {
      await withSlimSyncSource(async ({ sourceRoot }) => {
        await withConsumerRepo(async (local) => {
          const target = await writeRaw(local.tmpDir, relPath, "  \n");

          const { exitCode, stderr } = run(local.syncScript, "--sync", {
            cwd: local.tmpDir,
            testSourceRoot: sourceRoot,
          });

          assert.equal(exitCode, 0, stderr);
          const merged = JSON.parse(await fs.readFile(target, "utf8"));
          assert.equal(typeof merged, "object");
          assert.ok(merged.hooks, "source hooks must be merged into the empty file");
        });
      });
    });
  }

  for (const { relPath, label } of CONFIGS) {
    it(`fails closed when ${label} is a symlink to a missing target and does not create the target`, async (t) => {
      await withSlimSyncSource(async ({ sourceRoot }) => {
        await withConsumerRepo(async (local) => {
          const link = path.join(local.tmpDir, relPath);
          const missingTarget = path.join(local.tmpDir, "dangling-target.json");
          await fs.mkdir(path.dirname(link), { recursive: true });
          try {
            await fs.symlink(missingTarget, link);
          } catch (error) {
            if (error?.code === "EPERM" || error?.code === "EACCES") {
              t.skip("symlink creation is not permitted on this platform");
              return;
            }
            throw error;
          }

          const { exitCode, stderr } = run(local.syncScript, "--sync", {
            cwd: local.tmpDir,
            testSourceRoot: sourceRoot,
          });

          assert.notEqual(exitCode, 0, "sync must not report success");
          assert.ok(stderr.includes(label), `stderr must name ${label}: ${stderr}`);
          assert.ok(/symlink/i.test(stderr), `stderr must say it is a symlink: ${stderr}`);
          await assert.rejects(fs.lstat(missingTarget), { code: "ENOENT" }, "the link target must not be created");
          assert.ok((await fs.lstat(link)).isSymbolicLink(), "the link itself must stay in place");
        });
      });
    });
  }

  it("keeps merging valid JSON and preserves the consumer's own entries", async () => {
    await withSlimSyncSource(async ({ sourceRoot }) => {
      await withConsumerRepo(async (local) => {
        const relPath = path.join(".claude", "settings.json");
        const target = await writeRaw(
          local.tmpDir,
          relPath,
          `${JSON.stringify({ permissions: { allow: ["Bash(keep-me:*)"] } }, null, 2)}\n`
        );

        const { exitCode, stderr } = run(local.syncScript, "--sync", {
          cwd: local.tmpDir,
          testSourceRoot: sourceRoot,
        });

        assert.equal(exitCode, 0, stderr);
        const merged = JSON.parse(await fs.readFile(target, "utf8"));
        assert.ok(merged.permissions.allow.includes("Bash(keep-me:*)"));
        assert.ok(merged.hooks, "source hooks must still merge");
      });
    });
  });
});
