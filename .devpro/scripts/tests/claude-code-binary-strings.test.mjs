// T19 (strengthen-subagent-delegation-strategy design D10): the binary-string
// fixture is JSON with version + string counts, contains no absolute path, and
// its `version` MUST equal the version literal in the claude-code-capabilities
// adapter anchor — a mismatch is red, never silently carried forward.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const FIXTURE = new URL("./fixtures/claude-code-binary-strings.json", import.meta.url);
const CAPABILITIES = new URL("../../agent-rules/platform-adapters/claude-code-capabilities.md", import.meta.url);
const ANCHOR_VERSION = /Claude Code (\d+\.\d+\.\d+) 二進位字串/;

export function anchorVersionOf(capabilitiesText) {
  const match = ANCHOR_VERSION.exec(capabilitiesText);
  return match ? match[1] : null;
}

test("binary-string fixture is bounded JSON with the D10 key sets and no absolute path", () => {
  const raw = readFileSync(FIXTURE, "utf8");
  assert.doesNotMatch(raw, /\/Users\/|\/home\/|[A-Za-z]:\\\\|\/private\/var\//, "fixture must not record an absolute path");
  const fixture = JSON.parse(raw);
  assert.equal(fixture.schema, "devpro.claude-code-binary-strings/v1");
  assert.match(fixture.version, /^\d+\.\d+\.\d+$/);
  assert.match(fixture.captured_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(fixture.strings).sort(), [
    "CLAUDE_CODE_FORK_SUBAGENT",
    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
    "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION",
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
  ]);
  for (const [name, count] of Object.entries(fixture.strings)) {
    assert.ok(Number.isInteger(count) && count > 0, `${name} must be observed at least once`);
  }
  assert.deepEqual(fixture.absent, { forkMode: 0, CLAUDE_CODE_FORK_MODE: 0 });
});

test("fixture version equals the capabilities anchor version literal, and a drift is red", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const capabilities = readFileSync(CAPABILITIES, "utf8");
  const anchored = anchorVersionOf(capabilities);
  assert.ok(anchored, "claude-code-capabilities.md must carry exactly one anchored version literal for the binary-string probe");
  assert.equal(anchored, fixture.version, "fixture version and adapter anchor version must match; re-probe the binary instead of reusing the old value");
  assert.equal((capabilities.match(/\d+\.\d+\.\d+ 二進位字串/g) || []).length, 1, "single anchor line carries the version literal");
  const drifted = capabilities.replace(ANCHOR_VERSION, (m, v) => m.replace(v, "9.9.9"));
  assert.notEqual(anchorVersionOf(drifted), fixture.version, "a mismatched anchor must not compare equal");
});
