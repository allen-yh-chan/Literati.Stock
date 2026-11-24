/**
 * context-headroom-gate.mjs
 *
 * Gate CH (Context Headroom) — task 9 of add-change-cost-circuit-breaker.
 * D3 bounded-tail cache_read reader, D8 continuation-checkpoint judgment,
 * D12 change-identity resolution, and the pure four-state decision
 * function. Wired into pre-tool-gate.mjs's `BASH_BLOCKING_GATES` (see that
 * file for the table entry — `runGateInventory` dispatches on this
 * function's return shape: `{block,...}` / `{advisory,...}` / `null`).
 */
import { openSync, closeSync, readSync, statSync } from "node:fs";
import { computeChangeUsageStartupSnapshot } from "../../record-change-usage-checkpoint.mjs";
import { readChangeUsageCheckpoint } from "./change-usage-checkpoint.mjs";
import { defaultMainCheckoutRoot } from "./repo-state-identity.mjs";
import { sessionRuleLoadIdentity } from "./rule-load-session-ledger.mjs";
import { commandSegmentText } from "./shell-context.mjs";

/**
 * D3 bounded-tail read size: 2 MiB. Derived from an empirical max
 * single-turn-record size of 639,066 bytes × ~3.3 safety factor. MUST NOT
 * scale with total transcript file size — that invariant is NFR-1 and is
 * asserted directly in context-headroom-gate.test.mjs.
 */
export const TAIL_BYTES = 2 * 1024 * 1024;

/** Task 9 / design.md thresholds (tasks.md task 9 acceptance text). */
export const CH_ADVISORY_THRESHOLD = 300_000;
export const CH_BLOCK_THRESHOLD = 400_000;

/**
 * D3: reads the newest resolvable `cache_read_input_tokens` value from the
 * tail of a Claude Code transcript JSONL, reading at most `TAIL_BYTES` (+ a
 * fixed 1-byte boundary peek) regardless of total file size.
 *
 * Field access mirrors `lib/session-token-usage.mjs`'s own
 * `normalizeAssistantMessage` exactly (`record.message.usage
 * .cache_read_input_tokens`, NOT a top-level field) — verified against a
 * real transcript before writing this, since a wrong path here would make
 * the gate silently `unavailable` in production while still passing
 * self-authored fixture tests.
 *
 * Only `type:"assistant"` records with `isSidechain !== true` are
 * considered: subagent/fork transcripts in Claude Code live in a SEPARATE
 * `<session>/subagents/` directory tree (see
 * `lib/session-token-usage.mjs`'s `loadClaudeCodeSubagents`), so this is a
 * defensive filter, not a required one for the current on-disk layout —
 * cheap to keep, and it means a future format change that DID interleave
 * sidechain records could never silently attribute a fork's cache_read to
 * this session's own headroom.
 *
 * Returns `bytesRead` on every path (including "unavailable") so a
 * regression that falls back to a full-file scan is directly observable in
 * tests, not just inferable from "the function I expected wasn't called".
 */
export function readBoundedTailCacheRead({ transcriptPath }) {
  if (!transcriptPath) return { state: "unavailable", bytesRead: 0 };

  let size;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return { state: "unavailable", bytesRead: 0 };
  }
  if (size === 0) return { state: "unavailable", bytesRead: 0 };

  const wantStart = Math.max(0, size - TAIL_BYTES);
  // When wantStart > 0, read one extra leading byte so we can tell whether
  // the tail window happens to start exactly on a line boundary (F-5-6): if
  // that peek byte is "\n", the window is already aligned and the first
  // line MUST be kept, not discarded; only a genuine mid-line start
  // discards forward to the next "\n".
  const readStart = wantStart > 0 ? wantStart - 1 : 0;
  const length = size - readStart;

  let fd;
  let bytesRead = 0;
  let text = "";
  try {
    fd = openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(length);
    bytesRead = readSync(fd, buffer, 0, length, readStart);
    text = buffer.toString("utf8", 0, bytesRead);
  } catch {
    return { state: "unavailable", bytesRead };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close; nothing actionable if this fails
      }
    }
  }

  let usable = text;
  if (wantStart > 0) {
    const peek = text.charAt(0);
    const rest = text.slice(1);
    if (peek === "\n") {
      usable = rest;
    } else {
      const firstNewline = rest.indexOf("\n");
      usable = firstNewline === -1 ? "" : rest.slice(firstNewline + 1);
    }
  }

  const lines = usable.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "assistant") continue;
    if (record?.isSidechain === true) continue;
    const value = record?.message?.usage?.cache_read_input_tokens;
    if (typeof value === "number" && Number.isFinite(value)) {
      return { state: "ok", value, bytesRead };
    }
  }
  return { state: "unavailable", bytesRead };
}

const WORKTREE_CHANGE_NAME_PATTERN = /\.worktree[\\/]([^\\/]+)(?:[\\/]|$)/;

/**
 * D12: Gate CH's own change_name resolution — derived from hook-visible
 * cwd (NOT a TL-passed handoff like the renderer gets, and NOT the branch
 * name like post-PR gate uses). No grammar validation: unlike the
 * renderer/post-PR paths (F-5-5, human/branch-name provenance), a worktree
 * directory name is inherently well-formed here — it was created by the
 * enforced `/devpro:change` worktree-creation step.
 *
 * The same regex lives in `admission-record.mjs` (`resolveChangeIdFromCwd`),
 * which additionally enforces `CHANGE_ID_SHAPE` because there the name becomes
 * a filesystem write target. The divergence is intentional; keep both in step
 * (r15 F-r15-worktree-change-name-pattern-duplicated-across-two-hook-modules).
 */
export function resolveChangeNameFromWorktreeCwd(cwd) {
  const match = WORKTREE_CHANGE_NAME_PATTERN.exec(String(cwd || ""));
  return match ? match[1] : null;
}

/**
 * D8 + D12 F-3-1/F-3-2: resolves whether the >400K path's continuation-
 * checkpoint judgment can even be evaluated, and if so, its result.
 *
 * `available: false` means change_name and/or a session_id-matched
 * checkpoint baseline could not be resolved. Per F-3-2 this MUST degrade
 * the caller's >400K path to advisory, never block — the earlier
 * (rejected) design that treated "files exist and are non-empty" as a
 * usable fallback was a permanent, silent bypass; this function
 * deliberately does not offer that fallback.
 *
 * `available: true` carries `hasContinuationCheckpoint`: whether
 * `notes/session-pending.md` or this change's `tasks.md` grew (line count)
 * since this session's checkpoint start. Reuses the EXACT path/counting
 * logic `record-change-usage-checkpoint.mjs` used to write the
 * "_at_start" values (`computeChangeUsageStartupSnapshot`), so the two
 * sides of the comparison can never desync onto a plausible-but-different
 * path.
 */
export function resolveContinuationCheckpointState({ cwd, sessionId, changeName, checkpoint }) {
  if (!changeName || !sessionId || !checkpoint || checkpoint.status !== "ok") {
    return { available: false, hasContinuationCheckpoint: false };
  }
  const session = (checkpoint.sessions ?? []).find((s) => s.session_id === sessionId);
  if (!session) {
    return { available: false, hasContinuationCheckpoint: false };
  }
  const mainCheckoutRoot = defaultMainCheckoutRoot(cwd);
  const current = computeChangeUsageStartupSnapshot({ cwd, changeName, mainCheckoutRoot });
  const grew =
    current.session_pending_line_count_at_start > (session.session_pending_line_count_at_start ?? 0) ||
    current.tasks_line_count_at_start > (session.tasks_line_count_at_start ?? 0);
  return { available: true, hasContinuationCheckpoint: grew };
}

/**
 * Pure D3/D8/D12 decision function — no I/O. `cacheReadValue` is the D3
 * bounded-tail reading (absent/non-finite means "unavailable"). Four
 * distinguishable outcomes (task 9 acceptance (i)):
 *   - unavailable: cacheReadValue could not be resolved -> MUST NOT block
 *     (NFR-2).
 *   - ok: <=300K, OR >400K with a valid continuation checkpoint already
 *     written (D8) -> the remedy is done; no repeated nagging.
 *   - advisory: 300K-400K, OR >400K with baseline unavailable (F-3-2
 *     degrades to the SAME class as the plain >300K advisory, by design —
 *     see `degraded` flag to distinguish the mechanism in tests).
 *   - block: >400K, baseline available, no continuation checkpoint found —
 *     the one deliberately fail-closed branch in this gate.
 */
export function evaluateContextHeadroomGate({
  cacheReadValue,
  continuationCheckpointAvailable,
  hasContinuationCheckpoint,
}) {
  if (typeof cacheReadValue !== "number" || !Number.isFinite(cacheReadValue)) {
    return { state: "unavailable" };
  }
  if (cacheReadValue <= CH_ADVISORY_THRESHOLD) {
    return { state: "ok", cacheRead: cacheReadValue };
  }
  if (cacheReadValue <= CH_BLOCK_THRESHOLD) {
    return { state: "advisory", cacheRead: cacheReadValue };
  }
  if (!continuationCheckpointAvailable) {
    return { state: "advisory", cacheRead: cacheReadValue, degraded: true };
  }
  if (hasContinuationCheckpoint) {
    return { state: "ok", cacheRead: cacheReadValue, continuationCheckpoint: true };
  }
  return { state: "block", cacheRead: cacheReadValue };
}

const CH_TARGET_BASENAMES = new Set([
  "render-second-review-packet.mjs",
  "run-test-suite.mjs",
]);

// Splits a segmented command line into individually-invoked statements.
// Deliberately NOT high-output-command.mjs's own splitStatements: that
// splitter keeps `|` inside one statement for its own pipe-consumer
// analysis, which would hide a piped `node run-test-suite.mjs` invocation
// from tokens[0] position here.
const STATEMENT_SEPARATOR = /(?:&&|\|\||[;|&\n])/;

function stripTokenQuotes(token) {
  return String(token || "").replace(/^["']|["']$/g, "");
}

// Mirrors high-output-command.mjs's isNodeExecutableToken (tokenized-
// command-position precedent, F-3b8e05c4) — kept as a local pure primitive
// rather than imported so Gate CH does not take on Gate HO's unrelated
// pipe/high-output classification surface for a 3-line check.
function isNodeExecutableToken(token) {
  const value = stripTokenQuotes(token);
  return value === "node" || /\/node$/.test(value);
}

function statementTargetsGate(stmt) {
  const tokens = stmt.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || !isNodeExecutableToken(tokens[0])) return false;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = stripTokenQuotes(tokens[i]);
    if (token.startsWith("-")) continue; // skip node flags before the script path
    return CH_TARGET_BASENAMES.has(token.split("/").pop());
  }
  return false;
}

/**
 * D5: Gate CH's Bash-triggered path hooks onto invocations of these two
 * scripts specifically (dispatch-fanout is the OTHER trigger, wired
 * separately as an Agent/Task matcher — task 9 scope for the Bash side
 * only, per tasks.md).
 *
 * F-3b8e05c4 (round 2): a bare substring test over the raw command string
 * false-positived on a heredoc that merely mentioned a target script's name
 * and on a read-only `git diff -- <path>` whose path argument happened to
 * end in a target basename. Fixed by (1) running over
 * `commandSegmentText(cmd)` so quoted-string/heredoc-body content is opaque
 * `__QUOTED__` placeholder text, then (2) requiring the target basename to
 * appear in tokenized-command-position — the argument immediately following
 * a `node`/`.../node` executable token (skipping flags) in some statement —
 * not merely anywhere in the text. A `git diff -- .../run-test-suite.mjs`
 * path argument is real (unquoted) command text that survives step (1), but
 * `git` is not a node-executable token so step (2) still rejects it.
 * Still a cheap classification-first check, mirroring Gate HO's rationale —
 * this gate must not itself become a per-command cost source (NFR-1).
 */
export function commandTargetsContextHeadroomGate(cmd) {
  const segmented = commandSegmentText(cmd);
  return segmented.split(STATEMENT_SEPARATOR).some(statementTargetsGate);
}

function readPayloadTranscriptPath(payload) {
  return payload?.transcript_path || payload?.transcriptPath || "";
}

/**
 * Full Gate CH evaluation from a `pre-tool-gate.mjs` `checkBashCommand`
 * `ctx`-shaped input. Returns `{block, reason}` / `{advisory, ...}` /
 * `null` — the exact shape `runGateInventory` (pre-tool-gate.mjs) already
 * dispatches on, so this function IS the gate's `runner`.
 */
export function evaluateContextHeadroomGateFromCtx({ cmd, effectiveCwd, baseCwd, payload }) {
  if (!commandTargetsContextHeadroomGate(cmd)) return null;

  const transcriptPath = readPayloadTranscriptPath(payload);
  const tail = readBoundedTailCacheRead({ transcriptPath });
  if (tail.state !== "ok") return null;

  const cwd = effectiveCwd || baseCwd || "";
  const changeName = resolveChangeNameFromWorktreeCwd(cwd);
  const sessionId = sessionRuleLoadIdentity(payload);

  const checkpoint = changeName ? readChangeUsageCheckpoint({ cwd, changeName }) : null;
  const continuation = resolveContinuationCheckpointState({ cwd, sessionId, changeName, checkpoint });

  const decision = evaluateContextHeadroomGate({
    cacheReadValue: tail.value,
    continuationCheckpointAvailable: continuation.available,
    hasContinuationCheckpoint: continuation.hasContinuationCheckpoint,
  });

  if (decision.state === "block") {
    return {
      block: true,
      reason:
        `Gate CH（Context Headroom）：cache_read ≈ ${decision.cacheRead.toLocaleString()} tokens（>400K），` +
        `且找不到 continuation checkpoint（於 notes/session-pending.md 或本 change tasks.md 新增一行留存交接狀態後即可放行）。\n` +
        `pointer: token-frugal-io.md Context Headroom Gate`,
    };
  }
  if (decision.state === "advisory") {
    const degradedNote = decision.degraded
      ? "（change 識別或 session baseline 無法解析，已降級為 advisory-only）"
      : "";
    return {
      advisory:
        `Gate CH（Context Headroom）：cache_read ≈ ${decision.cacheRead.toLocaleString()} tokens，建議考慮 compact 或留 continuation checkpoint${degradedNote}。\n` +
        `pointer: token-frugal-io.md Context Headroom Gate`,
    };
  }
  return null;
}
