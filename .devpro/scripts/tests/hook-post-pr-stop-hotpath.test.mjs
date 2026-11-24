import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const RUN_HOOK = repoPath(".devpro/scripts/hooks/run-hook.mjs");
const STOP_HOOK = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");

test("Stop hot path exits under run-hook budget with large evidence root and empty markers", () => {
  const tmp = makeTempDir("post-pr-stop-hotpath-");
  try {
    const stateDir = path.join(tmp, "markers");
    const evidenceRoot = path.join(tmp, "control-evidence");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    for (let i = 0; i < 120; i += 1) {
      const id = `dispatch-hotpath-${String(i).padStart(3, "0")}`;
      const dir = path.join(evidenceRoot, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "dispatch.json"),
        `${JSON.stringify({
          schema: "devpro-second-review-dispatch/v1",
          repository_slug: "devpro/example",
          pr_number: String(3000 + i),
          head_ref_oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          attempt_id: `second-review-hotpath-${i}`,
          dispatch_id: id,
          previous_dispatch_id: null,
          packet_sha256: "a".repeat(64),
          carrier_root_id: "b".repeat(64),
        })}\n`,
      );
    }

    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [RUN_HOOK, "Stop", STOP_HOOK, "--host=opencode"],
      {
        cwd: tmp,
        encoding: "utf8",
        env: {
          ...process.env,
          DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
          DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
          DEVPRO_HOOK_TIMEOUT_MS: "30000",
        },
      },
    );
    const elapsed = Date.now() - started;
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(
      elapsed < 15000,
      `Stop hot path must stay well under run-hook timeout; elapsed=${elapsed}ms`,
    );
    assert.doesNotMatch(String(result.stderr || ""), /timed out after/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("run-test-suite injects control-evidence isolation guard for child tests", () => {
  const source = readFileSync(repoPath(".devpro/scripts/run-test-suite.mjs"), "utf8");
  assert.match(
    source,
    /DEVPRO_REQUIRE_ISOLATED_CONTROL_EVIDENCE/,
    "suite runner must inject isolation guard so tests cannot write the default evidence root",
  );
});
