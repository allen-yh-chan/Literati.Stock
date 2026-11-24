import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  run,
  withConsumerRepo,
  withSlimSyncSource,
} from "./lib/sync-agent-rules-harness.mjs";

it("does not sync source .github/workflows and preserves consumer workflows", async () => {
  await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
    await withConsumerRepo(async (local) => {
      const sourceWorkflow = path.join(slimSourceRoot, ".github", "workflows", "source-only.yml");
      const targetSourceWorkflow = path.join(local.tmpDir, ".github", "workflows", "source-only.yml");
      const consumerWorkflow = path.join(local.tmpDir, ".github", "workflows", "consumer.yml");
      const consumerContent = "name: consumer-owned\n";

      await fs.mkdir(path.dirname(sourceWorkflow), { recursive: true });
      await fs.mkdir(path.dirname(consumerWorkflow), { recursive: true });
      await fs.writeFile(sourceWorkflow, "name: source-owned\n");
      await fs.writeFile(consumerWorkflow, consumerContent);

      const { exitCode, stderr } = run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        testSourceRoot: slimSourceRoot,
      });
      assert.equal(exitCode, 0, stderr);
      assert.equal(
        await fs.access(targetSourceWorkflow).then(() => true).catch(() => false),
        false,
        "source .github/workflows files must not be copied to consumers"
      );
      assert.equal(
        await fs.readFile(consumerWorkflow, "utf8"),
        consumerContent,
        "consumer-owned workflows must be preserved"
      );

      const check = run(local.syncScript, "--check", {
        cwd: local.tmpDir,
        testSourceRoot: slimSourceRoot,
      });
      assert.equal(check.exitCode, 0, check.stderr);
    });
  });
});

it("does not sync hook runtime state files to consumers", async () => {
  await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
    await withConsumerRepo(async (local) => {
      const sourceState = path.join(slimSourceRoot, ".devpro", "scripts", "hooks", "state");
      const targetStateFile = path.join(local.tmpDir, ".devpro", "scripts", "hooks", "state", "pending-cd-to-worktree-demo");
      await fs.mkdir(sourceState, { recursive: true });
      await fs.writeFile(path.join(sourceState, "pending-cd-to-worktree-demo"), "/tmp/demo\n0\n");

      const { exitCode } = run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        testSourceRoot: slimSourceRoot,
      });
      assert.equal(exitCode, 0);
      assert.equal(
        await fs.access(targetStateFile).then(() => true).catch(() => false),
        false,
        "runtime hook state must not be copied to consumers"
      );
    });
  });
});
