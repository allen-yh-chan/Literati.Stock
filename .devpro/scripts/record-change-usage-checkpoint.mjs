#!/usr/bin/env node
/**
 * record-change-usage-checkpoint.mjs
 *
 * `/devpro:change` startup step 13 (see `change/SKILL.md` 第三步). Registers
 * this session's usage checkpoint (D7) and cross-change transition ledger
 * record (round 6 finding F-6-2) at `/devpro:change` startup, so task 3's
 * `--since-change` aggregation has an entry to read.
 *
 * Both writes go through `.devpro/scripts/hooks/lib/change-usage-checkpoint.mjs`,
 * which never throws — every write returns `{status:"written"}` or
 * `{status:"write_failed", reason}` (round 4 finding F-4-3). This script's
 * contract mirrors that discipline one layer up: a checkpoint write failure
 * is a local-state degradation, not a reason to block `/devpro:change` startup
 * (`notes/` is gitignored local state — blocking here has no remedy and
 * bricks the session). Failures are surfaced as a visible, non-blocking
 * advisory on stdout; the process always exits 0.
 *
 * `session_id`/`host` resolution reuses the existing `captureTlHostSession`
 * helper (`lib/session-usage-manifest.mjs`) — not reinvented here.
 */
import path from "node:path";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";
import { captureTlHostSession } from "./lib/session-usage-manifest.mjs";
import {
  appendChangeUsageSession,
  countFileLines,
  recordSessionChangeTransition,
} from "./hooks/lib/change-usage-checkpoint.mjs";
import { defaultMainCheckoutRoot } from "./hooks/lib/repo-state-identity.mjs";

/** D8 baseline snapshot: `notes/session-pending.md` lives at the shared
 * main-checkout-root (D7 path resolution); active `tasks.md` lives under the
 * change's own `openspec/changes/<changeName>/` inside the worktree this
 * script runs from (`cwd`) — this step runs from inside that worktree
 * (`/devpro:change` startup step 9 already `cd`'d into it). Both default to 0
 * when the file does not exist yet (a brand-new change's `tasks.md` very
 * plausibly does not exist at first-ever startup). */
export function computeChangeUsageStartupSnapshot({
  cwd = process.cwd(),
  changeName,
  mainCheckoutRoot = defaultMainCheckoutRoot(cwd),
} = {}) {
  const sessionPendingPath = path.join(mainCheckoutRoot, "notes", "session-pending.md");
  const tasksPath = path.join(cwd, "openspec", "changes", String(changeName), "tasks.md");
  return {
    session_pending_line_count_at_start: countFileLines(sessionPendingPath),
    tasks_line_count_at_start: countFileLines(tasksPath),
  };
}

function parseArgv(argv) {
  let change;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--change") {
      change = argv[index + 1];
      index += 1;
    }
  }
  return { change };
}

/**
 * Runs the full startup-checkpoint step and returns a result describing what
 * happened. NEVER throws — any unexpected failure is captured as an advisory
 * so the CLI entry point below can guarantee exit 0 unconditionally.
 */
export async function runRecordChangeUsageCheckpoint({
  cwd = process.cwd(),
  argv = process.argv.slice(2),
  env = process.env,
  now = () => new Date().toISOString(),
  captureSession = captureTlHostSession,
  appendSession = appendChangeUsageSession,
  recordTransition = recordSessionChangeTransition,
  mainCheckoutRoot,
} = {}) {
  const advisories = [];
  try {
    const { change: changeName } = parseArgv(argv);
    if (!changeName) {
      // Deliberately NOT an advisory: `<change-name>` is a value the calling
      // SKILL.md step already knows (used since step 7) and is responsible
      // for passing — a missing `--change` can only mean a caller-contract
      // bug in how this step itself was invoked, not an environmental gap.
      // Conflating it with write_failed/session-unresolvable (both
      // legitimate fail-open cases) would let a broken invocation silently
      // no-op forever, since exit 0 looks identical to success. This is a
      // usage error: fatal, loud, distinct from the advisories array.
      return {
        advisories,
        session: null,
        sessionCheckpoint: null,
        transitionLedger: null,
        fatalError: "missing --change <change-name>",
      };
    }

    const session = captureSession(env);
    if (!session?.session_id || !session?.host) {
      advisories.push(
        "no resolvable session_id/host from captureTlHostSession; skipping checkpoint write (non-blocking)"
      );
      return { advisories, session: null, sessionCheckpoint: null, transitionLedger: null };
    }

    const start_ts = now();
    const root = mainCheckoutRoot ?? defaultMainCheckoutRoot(cwd);
    const snapshot = computeChangeUsageStartupSnapshot({ cwd, changeName, mainCheckoutRoot: root });

    const sessionCheckpoint = appendSession({
      cwd,
      changeName,
      session_id: session.session_id,
      start_ts,
      host: session.host,
      session_pending_line_count_at_start: snapshot.session_pending_line_count_at_start,
      tasks_line_count_at_start: snapshot.tasks_line_count_at_start,
    });
    if (sessionCheckpoint?.status === "write_failed") {
      advisories.push(
        `per-change usage checkpoint write failed for change "${changeName}" (session ${session.session_id}): ${sessionCheckpoint.reason}`
      );
    }

    const transitionLedger = recordTransition({
      cwd,
      session_id: session.session_id,
      change_name: changeName,
      at: start_ts,
    });
    if (transitionLedger?.status === "write_failed") {
      advisories.push(
        `session-activity transition ledger write failed for change "${changeName}" (session ${session.session_id}): ${transitionLedger.reason}`
      );
    }

    return { advisories, session, sessionCheckpoint, transitionLedger };
  } catch (error) {
    advisories.push(`unexpected failure recording change usage checkpoint: ${error?.message || error}`);
    return { advisories, session: null, sessionCheckpoint: null, transitionLedger: null };
  }
}

if (isDirectCliInvocation(import.meta.url)) {
  runRecordChangeUsageCheckpoint()
    .then((result) => {
      // Usage error (missing --change): a caller-contract bug in how this
      // step itself was invoked, not a write/environmental degradation.
      // Loud and fatal on purpose — see runRecordChangeUsageCheckpoint's
      // fatalError branch for why this must NOT be folded into the
      // fail-open advisory path below.
      if (result.fatalError) {
        console.error(`[record-change-usage-checkpoint] USAGE ERROR: ${result.fatalError}`);
        process.exitCode = 1;
        return;
      }
      for (const advisory of result.advisories) {
        console.log(`[record-change-usage-checkpoint] ADVISORY: ${advisory}`);
      }
      if (result.advisories.length === 0) {
        console.log("[record-change-usage-checkpoint] checkpoint + transition ledger recorded.");
      }
      // Fail-open by design (D7/F-4-3): a local checkpoint write failure or
      // unresolvable session identity MUST NOT block `/devpro:change` startup.
      process.exitCode = 0;
    })
    .catch((error) => {
      console.log(`[record-change-usage-checkpoint] ADVISORY: unexpected failure: ${error?.message || error}`);
      process.exitCode = 0;
    });
}
