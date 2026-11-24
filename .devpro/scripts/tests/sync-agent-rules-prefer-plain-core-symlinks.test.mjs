/**
 * Host-neutral prove-it / unit coverage for prefer-plain when
 * core.symlinks=false|malformed (#1935 suggestion 2 /
 * fix-prefer-plain-core-symlinks-false).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  probeCoreSymlinksState,
  isPreferPlainCoreSymlinksState,
} from "../sync-agent-rules.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsRoot = path.resolve(scriptDir, "..");
const syncAgentRulesPath = path.join(scriptsRoot, "sync-agent-rules.mjs");

const PREFER_PLAIN_NOTE_SUBSTRING =
  "When git config core.symlinks=false (or unsettable), matching plain links are kept intentionally (prefer-plain)";
const SEPARATOR_WARN_NOTE =
  "True symlinks must not fail solely because readlink returns '\\' vs '/'; separator-normalized target checks apply after this fix.";

function mockRunner(status, stdout = "", { error = null, throwOnCall = false } = {}) {
  return () => {
    if (throwOnCall) throw new Error("forced probe spawn failure");
    return { status, stdout, stderr: "", error };
  };
}

describe("probeCoreSymlinksState four-state table", () => {
  it("maps false aliases to false (prefer-plain)", () => {
    for (const token of ["false", "FALSE", "no", "0", "off", " Off "]) {
      const state = probeCoreSymlinksState("/tmp/consumer", {
        runner: mockRunner(0, token),
      });
      assert.equal(state, "false", `token=${JSON.stringify(token)}`);
      assert.equal(isPreferPlainCoreSymlinksState(state), true);
    }
  });

  it("maps true aliases to true (upgrade path)", () => {
    for (const token of ["true", "TRUE", "yes", "1", "on", " On "]) {
      const state = probeCoreSymlinksState("/tmp/consumer", {
        runner: mockRunner(0, token),
      });
      assert.equal(state, "true", `token=${JSON.stringify(token)}`);
      assert.equal(isPreferPlainCoreSymlinksState(state), false);
    }
  });

  it("maps exit 1 (unset) to unset (upgrade path)", () => {
    const state = probeCoreSymlinksState("/tmp/consumer", {
      runner: mockRunner(1, ""),
    });
    assert.equal(state, "unset");
    assert.equal(isPreferPlainCoreSymlinksState(state), false);
  });

  it("maps bogus token / non-0-1 exit / spawn fail to malformed (prefer-plain)", () => {
    assert.equal(
      probeCoreSymlinksState("/tmp/consumer", { runner: mockRunner(0, "bogus") }),
      "malformed"
    );
    assert.equal(
      probeCoreSymlinksState("/tmp/consumer", { runner: mockRunner(0, "") }),
      "malformed"
    );
    assert.equal(
      probeCoreSymlinksState("/tmp/consumer", { runner: mockRunner(2, "false") }),
      "malformed"
    );
    assert.equal(
      probeCoreSymlinksState("/tmp/consumer", {
        runner: mockRunner(0, "false", { error: new Error("ENOENT") }),
      }),
      "malformed"
    );
    assert.equal(
      probeCoreSymlinksState("/tmp/consumer", {
        runner: mockRunner(0, "false", { throwOnCall: true }),
      }),
      "malformed"
    );
    assert.equal(isPreferPlainCoreSymlinksState("malformed"), true);
  });

  it("invokes runner with exact argv git config --get core.symlinks @ consumerRoot", () => {
    const calls = [];
    const runner = (root, args, options) => {
      calls.push({ root, args, options });
      return { status: 1, stdout: "", stderr: "", error: null };
    };
    const state = probeCoreSymlinksState("/abs/consumer", { runner });
    assert.equal(state, "unset");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].root, "/abs/consumer");
    assert.deepEqual(calls[0].args, ["config", "--get", "core.symlinks"]);
    assert.equal(calls[0].options?.cwd, "/abs/consumer");
  });
});

describe("prefer-plain WARN surface lock", () => {
  it("keeps degraded token, separator note, and prefer-plain policy substring", async () => {
    const syncSource = await fs.readFile(syncAgentRulesPath, "utf8");
    assert.match(syncSource, /managed-skill-discovery-degraded/);
    assert.match(syncSource, /matching plain links are kept intentionally \(prefer-plain\)/);
    assert.match(syncSource, /Prefer OS symlink creation \(Windows: Developer Mode\)/);
    assert.match(
      syncSource,
      /True symlinks must not fail solely because readlink returns/
    );
    assert.match(
      syncSource,
      /separator-normalized target checks apply after this fix\./
    );
    assert.equal(
      SEPARATOR_WARN_NOTE.includes("readlink returns '\\' vs '/'"),
      true
    );
    assert.match(syncSource, new RegExp(PREFER_PLAIN_NOTE_SUBSTRING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("warnManagedSkillDiscoveryDegraded accepts preferPlainActive option", async () => {
    const syncSource = await fs.readFile(syncAgentRulesPath, "utf8");
    assert.match(
      syncSource,
      /function warnManagedSkillDiscoveryDegraded\s*\(\s*degradedCount\s*,\s*\{\s*preferPlainActive/
    );
    assert.match(
      syncSource,
      /warnManagedSkillDiscoveryDegraded\(\s*degradedCount\s*,\s*\{\s*preferPlainActive\s*(?:,\s*failedCreations\s*)?\}\s*\)/
    );
    // Both sync and validate/--check share the helper with preferPlainActive (F2).
    const callCount = [
      ...syncSource.matchAll(
        /warnManagedSkillDiscoveryDegraded\(\s*degradedCount\s*,\s*\{\s*preferPlainActive\s*(?:,\s*failedCreations\s*)?\}\s*\)/g
      ),
    ].length;
    assert.ok(callCount >= 2, "sync and validate must both pass preferPlainActive");
  });
});
