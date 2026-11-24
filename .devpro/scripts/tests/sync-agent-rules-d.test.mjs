import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createConsumerRepo,
  run,
  setRunUsesFullSubmodSource,
} from "./lib/sync-agent-rules-harness.mjs";

// ---------------------------------------------------------------------------
// --sync (continued from sync-agent-rules.test.mjs)
//
// Second half of the original single "--sync" describe block, split into
// this sibling file to shorten the node --test integration-tier critical
// path. Shares the same before()/after() fixture shape as
// sync-agent-rules.test.mjs's "--sync" describe (each stands up its own
// createConsumerRepo({ fullSubmod: true }) via the shared harness module).
// ---------------------------------------------------------------------------
describe("--sync", { concurrency: false }, () => {
  let ctx;
  let rootScript;
  before(async () => {
    setRunUsesFullSubmodSource(true);
    ctx = await createConsumerRepo({ fullSubmod: true });
    const bootstrap = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
    assert.equal(bootstrap.exitCode, 0, bootstrap.stderr);
    rootScript = path.join(ctx.tmpDir, ".devpro", "scripts", "sync-agent-rules.mjs");
  });
  after(async () => {
    setRunUsesFullSubmodSource(false);
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("supports the root .devpro/scripts entrypoint after bootstrap sync", async () => {
    const expectedRoot = await fs.realpath(ctx.tmpDir);

    const { stdout, exitCode } = run(rootScript, "--sync", { cwd: ctx.tmpDir });

    assert.equal(exitCode, 0);
    assert.match(stdout, new RegExp(`consumerRoot=${expectedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("root entrypoint compares AGENTS.md against submodule source, not itself", async () => {
    const rootAgents = path.join(ctx.tmpDir, "AGENTS.md");
    const submoduleAgents = path.join(ctx.submod, "AGENTS.md");

    await fs.writeFile(rootAgents, "# stale root AGENTS\n");
    const checkBefore = run(rootScript, "--check", { cwd: ctx.tmpDir });
    assert.equal(checkBefore.exitCode, 1);
    assert.match(checkBefore.stderr, /Out of sync: AGENTS\.md differs/);

    const sync = run(rootScript, "--sync", { cwd: ctx.tmpDir });
    assert.equal(sync.exitCode, 0);
    assert.match(sync.stdout, /Synchronized AGENTS\.md/);
    assert.equal(
      await fs.readFile(rootAgents, "utf8"),
      await fs.readFile(submoduleAgents, "utf8")
    );
  });

  it("merges .codex/hooks.json hooks per event and preserves consumer extras", async () => {
    const hooksPath = path.join(ctx.tmpDir, ".codex", "hooks.json");
    await fs.mkdir(path.dirname(hooksPath), { recursive: true });
    await fs.writeFile(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "consumer-stop" }] }],
          ConsumerOnly: [{ hooks: [{ type: "command", command: "consumer-only" }] }],
        },
        consumerLocalKey: true,
      }, null, 2) + "\n"
    );

    const { exitCode } = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
    assert.equal(exitCode, 0);

    const source = JSON.parse(
      await fs.readFile(path.join(ctx.submod, ".codex", "hooks.json"), "utf8")
    );
    const target = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    assert.deepEqual(target.hooks.Stop, source.hooks.Stop,
      "source Stop hooks replace consumer Stop hooks as one event unit");
    assert.deepEqual(target.hooks.ConsumerOnly, [
      { hooks: [{ type: "command", command: "consumer-only" }] },
    ]);
    assert.equal(target.consumerLocalKey, true);
  });

  it("merges .cursor/hooks.json hooks per event and preserves consumer extras", async () => {
    const hooksPath = path.join(ctx.tmpDir, ".cursor", "hooks.json");
    await fs.mkdir(path.dirname(hooksPath), { recursive: true });
    await fs.writeFile(
      hooksPath,
      JSON.stringify({
        version: 0,
        hooks: {
          stop: [{ command: "consumer-stop" }],
          ConsumerOnly: [{ command: "consumer-only" }],
        },
        consumerLocalKey: true,
      }, null, 2) + "\n"
    );

    const { exitCode } = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
    assert.equal(exitCode, 0);

    const source = JSON.parse(
      await fs.readFile(path.join(ctx.submod, ".cursor", "hooks.json"), "utf8")
    );
    const target = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    assert.equal(target.version, source.version, "source version must overwrite consumer version");
    assert.deepEqual(target.hooks.stop, source.hooks.stop,
      "source stop hooks replace consumer stop hooks as one event unit");
    assert.deepEqual(target.hooks.ConsumerOnly, [
      { command: "consumer-only" },
    ]);
    assert.equal(target.consumerLocalKey, true);
  });

});
