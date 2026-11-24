/**
 * Shared fixture helpers for tests that need a real, resolvable change-cost-
 * usage checkpoint backed by an actual Claude Code transcript — needed where
 * a test must trigger a genuine `evaluateCostBudget` `exceeded` state (not
 * merely `unavailable`), which requires walking the real
 * `resolveChangeCostUsage` -> `aggregateSinceChangeUsage` ->
 * `collectSessionUsage` path rather than injecting a pre-built usage object.
 * Mirrors `report-session-token-usage.test.mjs`'s own reference "exceeded
 * exit code (1)" fixture construction (this module's third independent
 * occurrence, after that file and `render-second-review-packet.test.mjs`,
 * is why it was extracted here rather than copied a third time).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  appendChangeUsageSession,
  recordSessionChangeTransition,
} from "../../hooks/lib/change-usage-checkpoint.mjs";
import { makeTempDir } from "./tmp.mjs";

// `DEVPRO_CHANGE_USAGE_STATE_DIR` is read directly from `process.env` by
// `changeUsageStateDir` (no injected-env parameter exists on that path), so
// a real env mutation + restore is the only isolation mechanism available —
// same convention as `change-usage-checkpoint.test.mjs`'s `withStateDir`.
export function withChangeUsageStateDir(fn) {
  const dir = makeTempDir("devpro-change-usage-state-");
  const previous = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
  process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = previous;
  }
}

// `cacheReadTokens` and `endTs` default to the single-cheap-turn shape every
// existing caller relies on. `model_time` is not a field: it is derived from
// the turn's own timestamps (D6, sum of per-turn duration_ms), so moving
// `endTs` is the only way to drive threshold (c) from a fixture.
export function writeSingleTurnClaudeCodeFixture(root, sessionId, { startTs, outputTokens, cacheReadTokens = 0, endTs = "2026-01-01T00:00:01.000Z" }) {
  const projectDir = path.join(root, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  const records = [
    { type: "user", timestamp: startTs, cwd: "/repo", message: { id: "u1", role: "user", content: "hi" } },
    {
      type: "assistant",
      timestamp: endTs,
      message: {
        id: "m1",
        role: "assistant",
        model: "claude-opus-4",
        stop_reason: "end_turn",
        content: [],
        usage: { output_tokens: outputTokens, input_tokens: 0, cache_read_input_tokens: cacheReadTokens, cache_creation_input_tokens: 0 },
      },
    },
  ];
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));
}

/**
 * Seeds a change-usage checkpoint (session registered + transition
 * recorded) plus a matching real transcript under `claudeRoot`, so
 * `resolveChangeCostUsage` resolves a genuine, non-`unavailable` usage
 * rollup. Assumes `DEVPRO_CHANGE_USAGE_STATE_DIR` is already scoped by the
 * caller (e.g. via `withChangeUsageStateDir`) — this function does not touch
 * `process.env` itself.
 */
export function seedResolvableChangeCostUsage({ claudeRoot, changeName, sessionId, outputTokens, cacheReadTokens, endTs }) {
  const startTs = "2026-01-01T00:00:00.000Z";
  writeSingleTurnClaudeCodeFixture(claudeRoot, sessionId, { startTs, outputTokens, cacheReadTokens, endTs });
  appendChangeUsageSession({
    changeName,
    session_id: sessionId,
    start_ts: startTs,
    host: "claude-code",
    session_pending_line_count_at_start: 0,
    tasks_line_count_at_start: 0,
  });
  recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });
}
