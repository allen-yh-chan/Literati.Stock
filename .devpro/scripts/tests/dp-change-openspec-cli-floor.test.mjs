import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  DP_CHANGE_ENVIRONMENT_STAGES,
  OPENSPEC_MIN_VERSION,
  evaluateOpenSpecCliFloor,
  parseOpenSpecCliVersion,
} from "../dp-change-environment-checks.mjs";

test("parseOpenSpecCliVersion reads the first semver token", () => {
  assert.equal(parseOpenSpecCliVersion("1.11.0\n"), "1.11.0");
  assert.equal(parseOpenSpecCliVersion("openspec 1.8.2"), "1.8.2");
  assert.equal(parseOpenSpecCliVersion("no version here"), null);
});

test("openspec below 1.9.0 is blocked and tells the user to upgrade", () => {
  const result = evaluateOpenSpecCliFloor({ status: 0, stdout: "1.8.9\n", stderr: "" });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.check, "openspec-cli");
  assert.match(result.detail, /below required 1\.9\.0/);
  assert.match(result.detail, /npm install -g @fission-ai\/openspec@latest/);
  assert.equal(OPENSPEC_MIN_VERSION, "1.9.0");
});

test("openspec at or above 1.9.0 is compliant", () => {
  const atFloor = evaluateOpenSpecCliFloor({ status: 0, stdout: "1.9.0\n", stderr: "" });
  assert.equal(atFloor.outcome, "compliant");
  const newer = evaluateOpenSpecCliFloor({ status: 0, stdout: "1.11.0\n", stderr: "" });
  assert.equal(newer.outcome, "compliant");
});

test("missing openspec CLI stays risk, not blocked", () => {
  const result = evaluateOpenSpecCliFloor({ status: 1, stdout: "", stderr: "not found", error: null });
  assert.equal(result.outcome, "risk");
  assert.match(result.detail, /unavailable/);
});

test("openspec-cli is the first class-2 environment stage before clone-local checks", () => {
  assert.equal(DP_CHANGE_ENVIRONMENT_STAGES[0].check, "openspec-cli");
  assert.equal(DP_CHANGE_ENVIRONMENT_STAGES[1].check, "local-excludes");
  const blocked = evaluateOpenSpecCliFloor({ status: 0, stdout: "1.8.0\n", stderr: "" });
  assert.equal(blocked.outcome, "blocked");
});
