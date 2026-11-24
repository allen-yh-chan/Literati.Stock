/**
 * opencode-sync-lifecycle.test.mjs
 *
 * T7 / R6: SYNC_DIRS includes `.opencode`; --check fail-closed on missing/
 * drifted carriers; uninstall preserves consumer extras under `.opencode/`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { SYNC_DIRS, TEST_SYNC_SOURCE_ROOT_ENV } from "../sync-agent-rules.mjs";
import { SOURCE_ROOT } from "./lib/source-root.mjs";

async function writeTextFile(root, relPath, content) {
  const targetPath = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

describe("OpenCode sync lifecycle (T7)", () => {
  it("SYNC_DIRS includes .opencode", () => {
    assert.ok(
      SYNC_DIRS.some((d) => d.relPath === ".opencode"),
      "SYNC_DIRS must include .opencode for consumer parity"
    );
  });

  it("--sync copies OpenCode carriers; --check fails on drift; uninstall keeps extras", async () => {
    const consumerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-sync-dst-"));
    const submod = path.join(consumerRoot, ".devpro-agent-rules");
    try {
      await fs.mkdir(path.join(submod, ".devpro", "scripts"), { recursive: true });
      await fs.cp(
        path.join(SOURCE_ROOT, ".devpro", "scripts", "sync-agent-rules.mjs"),
        path.join(submod, ".devpro", "scripts", "sync-agent-rules.mjs")
      );
      // sync-agent-rules.mjs imports collectEntryTreeSkillSet from its
      // sibling lint-agent-skills.mjs (design D6) — a plain sync-agent-
      // rules.mjs + lib/ copy without it fails ERR_MODULE_NOT_FOUND.
      await fs.cp(
        path.join(SOURCE_ROOT, ".devpro", "scripts", "lint-agent-skills.mjs"),
        path.join(submod, ".devpro", "scripts", "lint-agent-skills.mjs")
      );
      await fs.cp(
        path.join(SOURCE_ROOT, ".devpro", "scripts", "lib"),
        path.join(submod, ".devpro", "scripts", "lib"),
        { recursive: true }
      );
      // sync also reads hooks/lib in some paths — copy cheaply if needed
      const hooksLib = path.join(SOURCE_ROOT, ".devpro", "scripts", "hooks", "lib");
      await fs.cp(hooksLib, path.join(submod, ".devpro", "scripts", "hooks", "lib"), {
        recursive: true,
      });

      const syncScript = path.join(submod, ".devpro", "scripts", "sync-agent-rules.mjs");
      const env = {
        ...process.env,
        [TEST_SYNC_SOURCE_ROOT_ENV]: SOURCE_ROOT,
      };

      const sync = spawnSync(process.execPath, [syncScript, "--sync"], {
        cwd: consumerRoot,
        encoding: "utf8",
        env,
        timeout: 120_000,
      });
      assert.equal(sync.status, 0, `sync failed: ${sync.stderr || sync.stdout}`);

      const pluginDst = path.join(consumerRoot, ".opencode/plugins/devpro-hooks.js");
      const pluginPkgDst = path.join(consumerRoot, ".opencode/plugins/package.json");
      const agentDst = path.join(consumerRoot, ".opencode/agent/dp-programmer.md");
      assert.equal(
        await fs.access(pluginDst).then(() => true).catch(() => false),
        true,
        "expected synced .opencode/plugins/devpro-hooks.js"
      );
      assert.equal(
        await fs.access(pluginPkgDst).then(() => true).catch(() => false),
        true,
        "expected synced .opencode/plugins/package.json (ESM load carrier)"
      );
      assert.equal(
        await fs.access(agentDst).then(() => true).catch(() => false),
        true,
        "expected synced OpenCode agent projection"
      );

      const extraRel = ".opencode/local-extra.plugin.js";
      await writeTextFile(consumerRoot, extraRel, "// consumer-owned\n");

      const original = await fs.readFile(pluginDst, "utf8");
      await fs.writeFile(pluginDst, `${original}\n// drifted\n`);
      const checkDrift = spawnSync(process.execPath, [syncScript, "--check"], {
        cwd: consumerRoot,
        encoding: "utf8",
        env,
        timeout: 120_000,
      });
      assert.notEqual(checkDrift.status, 0, "--check must fail on .opencode drift");
      assert.match(
        `${checkDrift.stderr}\n${checkDrift.stdout}`,
        /\.opencode/,
        "--check must mention .opencode"
      );

      await fs.writeFile(pluginDst, original);

      // Missing source-owned plugins/package.json must also fail --check.
      await fs.rm(pluginPkgDst);
      const checkMissingPkg = spawnSync(process.execPath, [syncScript, "--check"], {
        cwd: consumerRoot,
        encoding: "utf8",
        env,
        timeout: 120_000,
      });
      assert.notEqual(
        checkMissingPkg.status,
        0,
        "--check must fail when .opencode/plugins/package.json is missing"
      );
      // Restore for uninstall path
      await fs.cp(
        path.join(SOURCE_ROOT, ".opencode/plugins/package.json"),
        pluginPkgDst
      );

      const uninstall = spawnSync(process.execPath, [syncScript, "--uninstall", "--yes"], {
        cwd: consumerRoot,
        encoding: "utf8",
        env,
        timeout: 120_000,
      });
      assert.equal(
        uninstall.status,
        0,
        `uninstall failed: ${uninstall.stderr || uninstall.stdout}`
      );

      assert.equal(
        await fs.access(pluginDst).then(() => true).catch(() => false),
        false,
        "source-owned plugin must be removed on uninstall"
      );
      assert.equal(
        await fs.access(pluginPkgDst).then(() => true).catch(() => false),
        false,
        "source-owned plugins/package.json must be removed on uninstall"
      );
      assert.equal(
        await fs.readFile(path.join(consumerRoot, extraRel), "utf8"),
        "// consumer-owned\n",
        "consumer .opencode extra must be preserved"
      );
    } finally {
      await fs.rm(consumerRoot, { recursive: true, force: true });
    }
  });
});
