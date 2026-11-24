import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
const rulesDir = path.join(REPO_ROOT, ".devpro", "agent-rules");
const agentsDir = path.join(REPO_ROOT, ".claude", "agents");

const CROSS_MODEL =
  readFileSync(path.join(rulesDir, "code-review-cross-model.md"), "utf8") +
  "\n" +
  readFileSync(path.join(rulesDir, "code-review-cross-model-cli-contract.md"), "utf8");
const SECOND_REVIEWER = readFileSync(path.join(agentsDir, "dp-second-reviewer.md"), "utf8");
const LIB = readFileSync(path.join(REPO_ROOT, ".devpro", "scripts", "hooks", "lib", "host-auth-surface.mjs"), "utf8");

describe("Invariant 3: sandbox-surface-fault classification has a mechanical SSOT", () => {
  it("the classifier lib exists and exports the canonical functions", () => {
    assert.match(LIB, /export function classifyAuthSurfaceFault\(/, "classifyAuthSurfaceFault export missing");
    assert.match(LIB, /export function isFallbackAllowed\(/, "isFallbackAllowed export missing");
    // The four canonical classifications must be named.
    for (const cls of ["sandbox-surface-fault", "real-unavailable", "host-fault"]) {
      assert.match(LIB, new RegExp(cls.replace(/[-]/g, "[-]")), `classification ${cls} missing`);
    }
  });

  it("code-review-cross-model.md points sandbox classification at the mechanical SSOT lib", () => {
    assert.match(CROSS_MODEL, /sandbox-surface-fault/, "sandbox-surface-fault term missing");
    assert.match(CROSS_MODEL, /host-auth-surface\.mjs/, "rule must reference the classifier lib path");
    assert.match(CROSS_MODEL, /classifyAuthSurfaceFault/, "rule must name classifyAuthSurfaceFault");
    assert.match(CROSS_MODEL, /isFallbackAllowed/, "rule must name isFallbackAllowed");
    // The fail-closed requirement must be present in prose too.
    assert.match(CROSS_MODEL, /host-rerun|host rerun/, "host-rerun requirement missing");
  });

  it("devpro:second-review distinguishes missing-binary from sandbox auth false-negative", () => {
    assert.match(SECOND_REVIEWER, /host-auth-surface\.mjs/, "agent must reference the classifier lib");
    assert.match(SECOND_REVIEWER, /classifyAuthSurfaceFault/, "agent must name classifyAuthSurfaceFault");
    assert.match(SECOND_REVIEWER, /Not logged in/, "agent must call out the sandbox false-negative signal");
    assert.match(SECOND_REVIEWER, /sandbox false-negative/, "agent must frame it as a false-negative, not unavailable");
    assert.match(SECOND_REVIEWER, /MUST NOT/, "agent must forbid treating sandbox fault as unavailable");
    assert.match(SECOND_REVIEWER, /real-unavailable/, "agent must keep the genuine missing-binary path");
  });
});
