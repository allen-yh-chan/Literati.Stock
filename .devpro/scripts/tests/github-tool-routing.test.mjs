import test from "node:test";
import assert from "node:assert/strict";
import { classifyGhAuthentication, selectGithubRoute, probeGhAuthentication } from "../lib/github-tool-routing.mjs";

const ready = { installed: true, authentication: "authenticated" };

test("authenticated native gh is preferred even when MCP is available", () => {
  assert.deepEqual(selectGithubRoute({ ...ready, mcpAvailable: true }), { route: "cli", reason: "gh_authenticated" });
});

test("missing CLI and explicit missing login permit independently authorized MCP fallback", () => {
  for (const probe of [{ installed: false }, { installed: true, authentication: "not_logged_in" }]) {
    assert.equal(selectGithubRoute({ ...probe, mcpAvailable: true }).route, "mcp");
    assert.equal(selectGithubRoute({ ...probe, mcpAvailable: false }).route, "blocked");
  }
  for (const authentication of ["invalid", "timeout", undefined]) {
    assert.equal(selectGithubRoute({ installed: true, authentication, mcpAvailable: true }).route, "blocked");
  }
});

test("repository denial and uncertain operations stay blocked before any fallback", () => {
  for (const authentication of ["authenticated", "unknown", "not_logged_in"]) {
    for (const [state, reason] of [
      [{ targetPermission: "denied" }, "repository_permission_denied"],
      [{ outcome: "unknown" }, "write_outcome_unknown"],
      [{ failure: "network" }, "selected_route_failed"],
    ]) {
      assert.deepEqual(selectGithubRoute({ installed: true, authentication, mcpAvailable: true, ...state }),
        { route: "blocked", reason });
    }
  }
});

for (const [name, result] of [
  ["unsupported JSON option", { status: 1, stdout: "", stderr: "unknown flag: --json" }],
  ["timeout", { error: { code: "ETIMEDOUT" } }],
  ["process access denied", { error: { code: "EACCES" } }],
  ["malformed JSON", { status: 0, stdout: "not JSON" }],
]) {
  test(`pre-operation probe ${name} preserves unknown and permits available MCP`, () => {
    const observation = probeGhAuthentication({ spawn: () => result });
    assert.deepEqual(observation, { installed: true, authentication: "unknown" });
    assert.deepEqual(selectGithubRoute({ ...observation, mcpAvailable: true }),
      { route: "mcp", reason: "gh_probe_unavailable" });
    assert.deepEqual(selectGithubRoute({ ...observation, mcpAvailable: false }),
      { route: "blocked", reason: "gh_authentication_unknown" });
  });
}

test("a thrown pre-operation probe preserves unknown and uses independently available MCP", () => {
  const observation = probeGhAuthentication({ spawn: () => { throw new Error("probe unavailable"); } });
  assert.deepEqual(observation, { installed: true, authentication: "unknown" });
  assert.deepEqual(selectGithubRoute({ ...observation, mcpAvailable: true }),
    { route: "mcp", reason: "gh_probe_unavailable" });
});

test("gh JSON exit zero alone does not prove successful authentication", () => {
  const result = (account) => ({ status: 0, stdout: JSON.stringify({ hosts: { "github.com": [account] } }) });
  assert.equal(classifyGhAuthentication(result({ active: true, state: "success", login: "user" })).authentication, "authenticated");
  assert.equal(classifyGhAuthentication(result({ active: true, state: "failure" })).authentication, "invalid");
  assert.equal(classifyGhAuthentication(result({ active: false, state: "success" })).authentication, "unknown");
  assert.equal(classifyGhAuthentication({ status: 0, stdout: '{"hosts":{}}' }).authentication, "not_logged_in");
  assert.equal(classifyGhAuthentication({ status: 1, stdout: "", stderr: "network error" }).authentication, "unknown");
  assert.equal(classifyGhAuthentication({ error: { code: "ETIMEDOUT" } }).authentication, "unknown");
});

test("probe never requests or returns token material", () => {
  let seen;
  const probe = probeGhAuthentication({
    spawn: (command, args, options) => {
      seen = { command, args, options };
      return { status: 0, stdout: JSON.stringify({ hosts: { "github.com": [{ active: true, state: "success", login: "user", token: "secret" }] } }) };
    },
    cwd: "/tmp/test-github-routing",
  });
  assert.equal(probe.authentication, "authenticated");
  assert.equal(JSON.stringify(probe).includes("secret"), false);
  assert.equal(seen.args.includes("--show-token"), false);
  assert.equal(seen.options.shell, false);
  assert.ok(seen.options.timeout > 0);
});

test("only executable absence, not a failed process, means gh is missing", () => {
  assert.equal(probeGhAuthentication({ spawn: () => ({ error: { code: "ENOENT" } }) }).installed, false);
  assert.equal(probeGhAuthentication({ spawn: () => ({ error: { code: "EACCES" } }) }).installed, true);
});
