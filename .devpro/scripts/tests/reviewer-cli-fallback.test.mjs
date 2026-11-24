import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import {
  REVIEWER_CLI_UNAVAILABLE_CLASSIFICATIONS,
  isReviewerCliUnavailable,
  selectLocalReviewerCli,
} from "../lib/reviewer-cli-fallback.mjs";
import { TERMINAL_RECEIPT_CLASSIFICATIONS } from "../hooks/lib/second-review-control-evidence.mjs";

const unavailable = (cli) => ({ cli, classification: "tool_discovery_blocked" });

test("fallback: the first untried candidate is dispatched in the given order", () => {
  assert.deepEqual(selectLocalReviewerCli({ candidates: ["codex", "claude"] }), { action: "dispatch", cli: "codex", via: "order" });
  assert.deepEqual(
    selectLocalReviewerCli({ candidates: ["codex", "claude"], attempts: [unavailable("codex")] }),
    { action: "dispatch", cli: "claude", via: "order" },
  );
});

test("fallback: opencode follows only after every earlier candidate was truly unavailable", () => {
  assert.deepEqual(
    selectLocalReviewerCli({ candidates: ["codex", "claude"], attempts: [unavailable("codex"), unavailable("claude")] }),
    { action: "dispatch", cli: "opencode", via: "fallback" },
  );
  assert.deepEqual(
    selectLocalReviewerCli({ candidates: ["codex"], attempts: [unavailable("codex"), unavailable("opencode")] }),
    { action: "stop", reason: "all_unavailable" },
  );
});

test("fallback: an outcome that is not unavailability stands and never reaches opencode", () => {
  for (const classification of [
    "reviewer_completion_critical",
    "reviewer_completion_unavailable",
    "reviewer_completion_contract_invalid",
    "sticky_sha_mismatch",
    "reviewer_cli_timeout",
    "reviewer_tool_surface_mismatch",
    "reviewer_model_provenance_unverified",
    "reviewer_cli_completed",
  ]) {
    assert.deepEqual(
      selectLocalReviewerCli({ candidates: ["codex", "claude"], attempts: [{ cli: "codex", classification }] }),
      { action: "stop", reason: "outcome_stands", cli: "codex", classification },
      classification,
    );
  }
});

test("fallback: a failed host-surface probe is unavailable only when the probe allows a fallback", () => {
  const surface = (mayFallback) => selectLocalReviewerCli({
    candidates: ["codex"],
    attempts: [{ cli: "codex", classification: "reviewer_host_surface_unverified", mayFallback }],
  });
  assert.deepEqual(surface(true), { action: "dispatch", cli: "opencode", via: "fallback" });
  // sandbox-surface faults need a host rerun first; a wrong-model probe never sets the flag
  for (const mayFallback of [false, undefined]) {
    assert.deepEqual(surface(mayFallback), {
      action: "stop", reason: "outcome_stands", cli: "codex", classification: "reviewer_host_surface_unverified",
    });
  }
  // the flag cannot rescue any other classification
  assert.equal(isReviewerCliUnavailable("reviewer_completion_critical", { mayFallback: true }), false);
});

test("fallback: an unavailable earlier CLI does not excuse a later CLI's failed review", () => {
  assert.deepEqual(
    selectLocalReviewerCli({
      candidates: ["codex", "claude"],
      attempts: [unavailable("codex"), { cli: "claude", classification: "sticky_missing" }],
    }),
    { action: "stop", reason: "outcome_stands", cli: "claude", classification: "sticky_missing" },
  );
});

test("fallback: explicit selection bypasses the chain; a deepseek primary gets no opencode fallback", () => {
  assert.deepEqual(selectLocalReviewerCli({ explicit: "opencode" }), { action: "dispatch", cli: "opencode", via: "explicit" });
  assert.deepEqual(
    selectLocalReviewerCli({ candidates: ["codex"], primaryGroup: "deepseek", attempts: [unavailable("codex")] }),
    { action: "stop", reason: "all_unavailable" },
  );
});

test("fallback: unknown or empty input is rejected, not guessed", () => {
  assert.throws(() => selectLocalReviewerCli({ candidates: [] }), TypeError);
  assert.throws(() => selectLocalReviewerCli({ candidates: ["gemini"] }), TypeError);
  assert.throws(() => selectLocalReviewerCli({ explicit: "deepseek" }), TypeError);
  assert.throws(() => selectLocalReviewerCli({ candidates: ["codex"], attempts: [{ cli: "other", classification: "x" }] }), TypeError);
  // a mistyped primary group must not silently enable the opencode fallback
  assert.throws(() => selectLocalReviewerCli({ candidates: ["codex"], primaryGroup: "deepseeek" }), TypeError);
  assert.deepEqual(selectLocalReviewerCli({ candidates: ["codex"], primaryGroup: "anthropic" }), { action: "dispatch", cli: "codex", via: "order" });
});

test("fallback: the second-review skill lists exactly the closed unavailable set", () => {
  const skill = readFileSync(repoPath(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md"), "utf8");
  const listed = /unavailable 是封閉集合（([^）]+)）/u.exec(skill);
  assert.ok(listed, "SKILL.md must keep the unavailable list sentence");
  const names = [...listed[1].matchAll(/`([a-z_]+)`/g)].map((match) => match[1]).sort();
  assert.deepEqual(names, [...REVIEWER_CLI_UNAVAILABLE_CLASSIFICATIONS].sort());
  assert.ok(skill.includes("`reviewer_host_surface_unverified`"));
  assert.ok(skill.includes("may_fallback"));
});

test("fallback: the unavailable set is closed and every member is a real terminal classification", () => {
  assert.deepEqual([...REVIEWER_CLI_UNAVAILABLE_CLASSIFICATIONS].sort(), [
    "claude_reviewer_authentication_failed",
    "claude_reviewer_provider_rate_limited",
    "reviewer_cli_spawn_failed",
    "tool_discovery_blocked",
  ]);
  for (const classification of REVIEWER_CLI_UNAVAILABLE_CLASSIFICATIONS) {
    assert.ok(TERMINAL_RECEIPT_CLASSIFICATIONS.has(classification), classification);
    assert.equal(isReviewerCliUnavailable(classification), true);
  }
  assert.equal(isReviewerCliUnavailable("reviewer_completion_unavailable"), false);
});
