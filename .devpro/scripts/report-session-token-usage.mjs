#!/usr/bin/env node
/**
 * report-session-token-usage.mjs
 *
 * Thin CLI: argv parsing + calling lib/session-token-usage.mjs + printing +
 * process.exit. All logic lives in the lib (D10 lib + thin-CLI convention,
 * mirrors report-governance-ratio.mjs / lib/rule-token-budget.mjs).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  aggregateSinceChangeUsage,
  collectSessionUsage,
  enumerateCodexLineageMetadata,
  groupTurnsByClass,
  renderByClassSummary,
  renderMarkdownLedger,
  resolveRoots,
  sanitizeHomeAndCwd,
  sanitizeResultItems,
  unionCheckpointMeasurementSessions,
} from "./lib/session-token-usage.mjs";
import { controlEvidenceRoot } from "./hooks/lib/second-review-control-evidence.mjs";
import {
  readChangeUsageCheckpoint,
  readSessionChangeTransitions,
} from "./hooks/lib/change-usage-checkpoint.mjs";
import {
  captureTlHostSession,
  discoverUsageManifests,
  parseDispatchIdList,
  renderManifestRollupMarkdown,
  rollupManifestUsage,
  collectChangeScopedExternalReviewerSessions,
} from "./lib/session-usage-manifest.mjs";
import {
  buildLineageUsageReport,
  canonicalSessionIdentity,
  parseEvidenceBoundary,
  probeClaudeLineageMetadata,
  renderLineageSummaryMarkdown,
  loadAdmissionRecords,
  deriveCodexDescendantEvidence,
} from "./lib/session-usage-lineage.mjs";
import { deriveEffectiveBudgetState, evaluateCostBudget } from "./lib/cost-budget.mjs";
import { resolveCostBudgetOverride, ROUND_EXTENSION_HINT } from "./lib/cost-budget-override.mjs";
// D10: `--budget-check` is the one surface that evaluates `stalled_rounds`, and
// this is how it gets the observation. Statically imported because `main()` is
// synchronous -- there is no `await` available for a lazy import inside the
// `--budget-check` branch, and paying the module's parse cost on every
// invocation is the cheaper of the two remaining options.
import { queryReviewStallState } from "./review-remediation-evidence.mjs";
import { resolveAnchor } from "./detect-branch-base.mjs";

// D10/D11: three stable, distinct exit codes for --budget-check. UNAVAILABLE
// MUST NOT be conflated with OK — "nothing was checked" is not "checked and
// clean" (DW2 / proposal.md).
const BUDGET_EXIT = Object.freeze({ OK: 0, EXCEEDED: 1, UNAVAILABLE: 2 });

const METER_RESET_GRACE_MS = 24 * 60 * 60 * 1000;

// D23/D24: HEAD of the caller's cwd, or null when cwd is not a git work tree
// (the override resolver then reports head_ref_oid_unresolvable and stays
// non-effective — the original exceeded block stands).
function resolveHeadRefOid(cwd) {
  try {
    const oid = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40}$/u.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

function earliestSessionStartTs(sessions) {
  const valid = (sessions ?? [])
    .map((s) => s?.start_ts)
    .filter((ts) => typeof ts === "string" && !Number.isNaN(Date.parse(ts)));
  if (valid.length === 0) return null;
  return valid.reduce((earliest, ts) => (Date.parse(ts) < Date.parse(earliest) ? ts : earliest));
}

// F-3-3: anchor `.sha` MUST be recomputed fresh on every call via the same
// live resolution `detect-branch-base.mjs --anchor` uses (origin/main-based,
// fail-closed rather than a stale local `main`) — NEVER read from the
// checkpoint's diagnostic-only `root_head` field, which is itself the
// suspect object in a meter-reset scenario and cannot also be the detection
// baseline (design.md F-3-3 circularity).
function firstCommitAuthorTsSinceAnchor(cwd) {
  let anchorSha;
  try {
    anchorSha = resolveAnchor().sha;
  } catch {
    return null;
  }
  if (!anchorSha) return null;
  let output;
  try {
    output = execFileSync("git", ["log", "--reverse", "--format=%aI", `${anchorSha}..HEAD`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const firstLine = output.split("\n").find((line) => line.trim().length > 0);
  return firstLine ?? null;
}

/** F-1-4 meter-reset advisory (never blocks — this value never feeds an exit
 * code). Tri-state (`true`/`false`/`"unavailable"`), not a bare boolean: an
 * inconclusive check (no commits since anchor yet, anchor/git resolution
 * failure, or no session `start_ts` on record) MUST NOT collapse into
 * `false` — that would silently misrepresent "couldn't check" as "checked,
 * clean", the same fail-open shape task 4's evaluateNumericThreshold fix
 * closed for the four cost thresholds, applied here proactively. */
function detectMeterReset({ cwd, sessions }) {
  const earliestStartTs = earliestSessionStartTs(sessions);
  if (earliestStartTs === null) return "unavailable";
  const firstCommitTs = firstCommitAuthorTsSinceAnchor(cwd);
  if (firstCommitTs === null) return "unavailable";
  const offsetMs = Date.parse(earliestStartTs) - Date.parse(firstCommitTs);
  return offsetMs > METER_RESET_GRACE_MS;
}

function parseArgs(argv) {
  const opts = {
    host: "auto",
    session: undefined,
    latest: false,
    json: false,
    top: 10,
    sort: "output",
    itemWidth: 80,
    help: false,
    rollupManifests: false,
    controlEvidenceRoot: undefined,
    dispatchIds: [],
    repositorySlug: undefined,
    headRefOidPrefix: undefined,
    sinceChange: undefined,
    budgetCheck: false,
    // D4 (fix-second-review-loop-friction): `--pr-number` is retired. This
    // flag only tracks PRESENCE (any value, including `none`) so the
    // above-checkpoint-read guard can reject it regardless of what was
    // passed — the value itself is never consumed by anything below.
    prNumberFlagPresent: false,
    byClass: false,
    lineage: false,
    evidenceBoundary: undefined,
    hostExplicit: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--by-class") opts.byClass = true;
    else if (a === "--lineage") opts.lineage = true;
    else if (a === "--evidence-boundary") opts.evidenceBoundary = argv[(i += 1)];
    else if (a.startsWith("--evidence-boundary=")) opts.evidenceBoundary = a.slice("--evidence-boundary=".length);
    else if (a === "--rollup-manifests") opts.rollupManifests = true;
    else if (a === "--control-evidence-root") opts.controlEvidenceRoot = argv[(i += 1)];
    else if (a.startsWith("--control-evidence-root=")) {
      opts.controlEvidenceRoot = a.slice("--control-evidence-root=".length);
    } else if (a === "--dispatch") opts.dispatchIds.push(argv[(i += 1)]);
    else if (a.startsWith("--dispatch=")) opts.dispatchIds.push(a.slice("--dispatch=".length));
    else if (a === "--dispatches") {
      opts.dispatchIds.push(...parseDispatchIdList(argv[(i += 1)]));
    } else if (a.startsWith("--dispatches=")) {
      opts.dispatchIds.push(...parseDispatchIdList(a.slice("--dispatches=".length)));
    } else if (a === "--repository-slug") opts.repositorySlug = argv[(i += 1)];
    else if (a.startsWith("--repository-slug=")) {
      opts.repositorySlug = a.slice("--repository-slug=".length);
    } else if (a === "--head-ref-oid-prefix") opts.headRefOidPrefix = argv[(i += 1)];
    else if (a.startsWith("--head-ref-oid-prefix=")) {
      opts.headRefOidPrefix = a.slice("--head-ref-oid-prefix=".length);
    } else if (a === "--since-change") opts.sinceChange = argv[(i += 1)];
    else if (a.startsWith("--since-change=")) opts.sinceChange = a.slice("--since-change=".length);
    else if (a === "--budget-check") opts.budgetCheck = true;
    else if (a === "--pr-number") {
      opts.prNumberFlagPresent = true;
      i += 1; // consume the value; retired flag reads nothing from it
    } else if (a.startsWith("--pr-number=")) opts.prNumberFlagPresent = true;
    else if (a === "--host") {
      opts.host = argv[(i += 1)];
      opts.hostExplicit = true;
    } else if (a.startsWith("--host=")) {
      opts.host = a.slice("--host=".length);
      opts.hostExplicit = true;
    }
    else if (a === "--session") opts.session = argv[(i += 1)];
    else if (a.startsWith("--session=")) opts.session = a.slice("--session=".length);
    else if (a === "--latest") opts.latest = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--top") opts.top = Number(argv[(i += 1)]);
    else if (a.startsWith("--top=")) opts.top = Number(a.slice("--top=".length));
    else if (a === "--sort") opts.sort = argv[(i += 1)];
    else if (a.startsWith("--sort=")) opts.sort = a.slice("--sort=".length);
    else if (a === "--item-width") opts.itemWidth = Number(argv[(i += 1)]);
    else if (a.startsWith("--item-width=")) opts.itemWidth = Number(a.slice("--item-width=".length));
  }
  return opts;
}

function safeGit(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return ""; // not a git repo, git not installed, etc. — fail-open to just `cwd`.
  }
}

/**
 * F-I6: cwdRoots MUST include the git repo root and any worktree roots
 * (design.md D10), not just `process.cwd()` — a session recorded with cwd at
 * the main repo root, or under a DIFFERENT linked worktree of the same repo,
 * would otherwise never match `matchesCwdRoots`'s segment-wise prefix check.
 */
export function resolveCwdRoots(cwd = process.cwd()) {
  const roots = new Set([cwd]);
  const repoRoot = safeGit(["rev-parse", "--show-toplevel"], cwd);
  if (repoRoot) roots.add(repoRoot);
  const worktreeList = safeGit(["worktree", "list", "--porcelain"], cwd);
  if (worktreeList) {
    for (const line of worktreeList.split("\n")) {
      if (line.startsWith("worktree ")) {
        const worktreeRoot = line.slice("worktree ".length).trim();
        if (worktreeRoot) roots.add(worktreeRoot);
      }
    }
  }
  return [...roots];
}

// F-S1: route both hosts through the single collectSessionUsage(...) dispatch
// instead of calling readClaudeCodeSession/readCodexSession directly — the
// CLI no longer has its own copy of the "pick a reader for this host" logic.
function runHost(host, { opts, roots, env, cwdRoots }) {
  const root = host === "claude-code" ? roots.claudeRoot : roots.codexRoot;
  return collectSessionUsage({
    host,
    root,
    sessionId: opts.session,
    latest: opts.latest,
    cwdRoots,
    env,
  });
}

function createLineageHostAdapters({ roots, env, cwdRoots, usageOverrides = new Map() }) {
  const usageCache = new Map(usageOverrides);
  // T10: usage overrides (checkpoint totals) MUST NOT short-circuit the
  // transcript read that carries spawn evidence (`lineage_relationships`,
  // `lineage_root_usage`); keep a separate activity cache for that.
  const activityCache = new Map();
  const readSessionActivity = ({ host, session_id }) => {
    const key = `${host}:${session_id}`;
    if (activityCache.has(key)) return activityCache.get(key);
    const root = host === "claude-code" ? roots.claudeRoot : roots.codexRoot;
    const activity = collectSessionUsage({ host, root, sessionId: session_id, cwdRoots, env });
    activityCache.set(key, activity);
    return activity;
  };
  const readSessionUsage = ({ host, session_id }) => {
    const key = `${host}:${session_id}`;
    const override = usageCache.get(key);
    if (override) return override;
    const usage = readSessionActivity({ host, session_id });
    usageCache.set(key, usage);
    return usage;
  };
  return {
    codex: {
      enumerateMetadata: ({ root: measurementRoot, limits }) => {
        const rootSessionId = measurementRoot.session_id ?? measurementRoot.session;
        const metadata = enumerateCodexLineageMetadata({
          root: roots.codexRoot,
          rootSessionId,
          limits,
        });
        const childrenByParent = new Map();
        for (const edge of metadata.edges) {
          const children = childrenByParent.get(edge.parent_identity) ?? [];
          children.push(edge.child_identity);
          childrenByParent.set(edge.parent_identity, children);
        }

        const reachableIdentities = new Set();
        const queue = [`codex:${rootSessionId}`];
        while (queue.length > 0) {
          const identity = queue.shift();
          if (reachableIdentities.has(identity)) continue;
          reachableIdentities.add(identity);
          queue.push(...(childrenByParent.get(identity) ?? []));
        }

        metadata.spawn_events = 0;
        const activities = new Map();
        for (const identity of [...reachableIdentities].sort()) {
          const sessionId = identity.slice("codex:".length);
          // T29: continuation/dispatch evidence lives in the parsed rollout, which a
          // checkpoint usage override never carries — read the activity itself.
          //
          // I-06 (PR #2473 second cross-model round): `spawn_events` and
          // `spawn_observability` ARE that evidence, yet they used to be read from
          // the override-aware `readSessionUsage`, one line above the comment saying
          // an override never carries it. Under `--since-change` — the mode this
          // change exists to serve — every override therefore yielded
          // `spawn_events ?? 0` and a non-"complete" observability, degrading Codex
          // spawn observability to `partial` from evidence that was actually present.
          // The override stays the authority for token totals only.
          const activity = readSessionActivity({ host: "codex", session_id: sessionId });
          activities.set(identity, activity);
          if (!activity.available) {
            metadata.gaps.push({ name: "codex-spawn-observability-unverified", identity });
            metadata.spawn_observability = "partial";
            continue;
          }
          const spawnEvents = activity.spawn_events ?? 0;
          metadata.spawn_events += spawnEvents;
          if (activity.spawn_observability !== "complete") {
            metadata.gaps.push({ name: "codex-spawn-observability-unverified", identity });
            metadata.spawn_observability = "partial";
          }
          const resolvedDirectChildren = (childrenByParent.get(identity) ?? []).length;
          if (spawnEvents > resolvedDirectChildren) {
            metadata.gaps.push({ name: "codex-descendant-usage-missing", identity });
            metadata.spawn_observability = "partial";
          }
        }
        // T29: Codex descendant delegation evidence (fixture-backed carriers only);
        // gaps ride on the node into `delegation.gaps`, never into spawn observability.
        const parentByChild = new Map(metadata.edges.map((edge) => [edge.child_identity, edge.parent_identity]));
        for (const node of metadata.nodes) {
          const identity = `codex:${node.session_id}`;
          if (identity === `codex:${rootSessionId}` || !reachableIdentities.has(identity) || !node.spawn_carrier) continue;
          const derived = deriveCodexDescendantEvidence({
            spawnCarrier: node.spawn_carrier,
            activity: activities.get(identity),
            parentActivity: activities.get(parentByChild.get(identity)),
          });
          if (derived.context_mode) node.context_mode = derived.context_mode;
          node.delegation_evidence = derived.delegation_evidence;
          node.delegation_gaps = derived.gaps;
          delete node.spawn_carrier;
        }
        return metadata;
      },
      readSessionUsage,
    },
    "claude-code": {
      enumerateMetadata: ({ root: measurementRoot }) => {
        const rootSessionId = measurementRoot.session_id ?? measurementRoot.session;
        const activity = readSessionActivity({ host: "claude-code", session_id: rootSessionId });
        const relationships = activity?.lineage_relationships ?? [];
        if (!activity?.available || relationships.length === 0) {
          return {
            nodes: [],
            edges: [],
            gaps: [{ name: "claude-context-mode-unknown" }],
            diagnostics: [],
            spawn_events: relationships.length,
            spawn_observability: "unavailable",
          };
        }
        if (activity.lineage_root_usage && !usageOverrides.has(`claude-code:${rootSessionId}`)) {
          usageCache.set(`claude-code:${rootSessionId}`, activity.lineage_root_usage);
        }
        for (const relationship of relationships) {
          if (relationship?.session_id && relationship?.usage) {
            usageCache.set(`claude-code:${relationship.session_id}`, relationship.usage);
          }
        }
        const metadata = probeClaudeLineageMetadata({
          parent: { host: "claude-code", session_id: rootSessionId },
          relationships,
        });
        if ((activity.gaps ?? []).some((gap) => [
          "subagent-read-failed",
          "subagent-missing-tool-use-id",
          "subagent-unattached",
        ].includes(gap.name))) {
          metadata.gaps.push({ name: "host-lineage-evidence-unavailable" });
          metadata.spawn_observability = "partial";
        }
        return metadata;
      },
      readSessionUsage,
    },
  };
}

function createLineageReport({ measurementRoots, externalSessions = [], boundary, roots, env, cwdRoots, usageOverrides, admissionRecords }) {
  return buildLineageUsageReport({
    roots: measurementRoots,
    externalSessions,
    boundary,
    ...(admissionRecords ? { admissionRecords } : {}),
    hostAdapters: createLineageHostAdapters({ roots, env, cwdRoots, usageOverrides }),
  });
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  // D4 (fix-second-review-loop-friction): `--pr-number` is retired — there is
  // no cost-side `round` threshold left for it to feed (D1). Rejected before
  // any checkpoint read (never a silently-ignored flag: `output-discipline`'s
  // "never a silently ignored flag" — a caller that kept passing it must not
  // read a quiet exit 0/1 as "still checking rounds"). Same UNAVAILABLE (2)
  // exit code this CLI already uses for an unsupported flag combination.
  // Unconditional on `--pr-number` presence alone (output-discipline spec
  // `--pr-number` never a silently ignored flag; F-slf-r1-04) — NOT gated on
  // `--budget-check` also being present, so a caller passing `--pr-number`
  // without `--budget-check` is rejected the same way, not silently ignored.
  // Checked before the `--help` early return as well (PR #2875 cross-model
  // review): otherwise `--help --pr-number` exits 0.
  // Message composed from `ROUND_EXTENSION_HINT` (F-slf-r1-06) so the hint
  // text exists once in non-test code, shared with cost-budget-override.mjs's
  // own `unknown_threshold_key` hint for the same legacy `round` token.
  if (opts.prNumberFlagPresent) {
    console.error(`--pr-number is retired: ${ROUND_EXTENSION_HINT}`);
    return BUDGET_EXIT.UNAVAILABLE;
  }
  if (opts.help) {
    console.log(
      "Usage: node .devpro/scripts/report-session-token-usage.mjs " +
        "[--host claude-code|codex|auto] [--session <id>] [--latest] [--json] " +
        "[--lineage] [--evidence-boundary <path>] " +
        "[--top N] [--sort output|cache_read|cache_creation|duration] [--item-width N] " +
        "[--by-class] " +
        "[--rollup-manifests [--control-evidence-root <dir>] " +
        "[--dispatch <id> ... | --dispatches id1,id2] " +
        "[--repository-slug owner/name] [--head-ref-oid-prefix <sha-prefix>]] " +
        "[--since-change <name> [--budget-check]]",
    );
    return 0;
  }

  if (opts.budgetCheck && opts.lineage) {
    console.error("--budget-check is not supported together with --lineage; budget denominators remain legacy root-only");
    return BUDGET_EXIT.UNAVAILABLE;
  }
  if (opts.evidenceBoundary && (
    opts.hostExplicit || opts.session || opts.latest || opts.sinceChange || opts.rollupManifests || opts.budgetCheck || opts.byClass
  )) {
    console.error("--evidence-boundary is an independent mode and cannot be combined with host/session/latest/since-change/rollup/budget/by-class flags");
    return BUDGET_EXIT.UNAVAILABLE;
  }

  const homeDir = env.HOME ?? os.homedir();
  const roots = resolveRoots(env, homeDir);
  const cwdRoots = resolveCwdRoots(process.cwd());

  if (opts.evidenceBoundary) {
    let boundary;
    try {
      const raw = JSON.parse(readFileSync(opts.evidenceBoundary, "utf8"));
      boundary = parseEvidenceBoundary(raw, { sourceName: opts.evidenceBoundary });
    } catch {
      console.error("evidence boundary unavailable or invalid");
      return BUDGET_EXIT.UNAVAILABLE;
    }
    const report = createLineageReport({
      measurementRoots: boundary.roots,
      externalSessions: boundary.external_sessions,
      boundary,
      roots,
      env,
      cwdRoots,
    });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.log(renderLineageSummaryMarkdown(report));
    return 0;
  }

  if (opts.rollupManifests) {
    if (opts.byClass) {
      // Same silent-drop shape as the --since-change guard below: the manifest
      // rollup aggregates per-dispatch/per-session totals across a
      // control-evidence tree — it never holds the individual turns
      // groupTurnsByClass needs. Exit code MUST be UNAVAILABLE (2), not 1 —
      // this CLI reserves 1 for BUDGET_EXIT.EXCEEDED; a caller that branches
      // on exit code alone (e.g. a pre-dispatch budget gate) must not read
      // this usage error as "budget exceeded, block."
      console.error("--by-class is not supported together with --rollup-manifests; rerun with --host/--session (or --latest) --by-class instead");
      return BUDGET_EXIT.UNAVAILABLE;
    }
    const evidenceRoot = opts.controlEvidenceRoot ?? controlEvidenceRoot(env, process.cwd());
    const { manifests, missingDispatchIds } = discoverUsageManifests({
      rootDir: evidenceRoot,
      dispatchIds: opts.dispatchIds.length > 0 ? opts.dispatchIds : null,
      repositorySlug: opts.repositorySlug ?? null,
      headRefOidPrefix: opts.headRefOidPrefix ?? null,
    });
    const rollup = rollupManifestUsage({
      manifests,
      missingDispatchIds,
      collectSessionUsage,
      roots,
      env,
      cwdRoots,
      homeDir,
      itemWidth: opts.itemWidth,
    });
    if (opts.lineage) {
      const uniqueRoots = new Map();
      const externalSessions = [];
      const usageOverrides = new Map();
      for (const dispatch of rollup.dispatches) {
        for (const { manifestSession, usage } of dispatch.sessions) {
          const entry = {
            host: manifestSession.host,
            session_id: manifestSession.session_id,
            dispatch_id: dispatch.manifest.dispatch_id,
            source: "exact",
          };
          if (manifestSession.role === "tl-host") uniqueRoots.set(`${entry.host}:${entry.session_id}`, entry);
          else if (manifestSession.role === "reviewer") {
            externalSessions.push(entry);
            if (usage?.available === true) {
              usageOverrides.set(`${entry.host}:${entry.session_id}`, usage);
            }
          }
        }
      }
      rollup.lineage = createLineageReport({
        measurementRoots: [...uniqueRoots.values()],
        externalSessions,
        boundary: { scope: "session-wide" },
        roots,
        env,
        cwdRoots,
        usageOverrides,
      });
      rollup.lineage.gaps.push(...rollup.gaps.filter(gap => (typeof gap?.name === "string" && gap.name.startsWith("reviewer-window-")) || gap?.name === "usage-manifest-missing"));
      if (rollup.coverage_status !== "complete") {
        rollup.lineage.claim.coverage = "lineage-incomplete";
        rollup.lineage.claim.claims = (rollup.lineage.claim.claims ?? []).filter(claim => claim !== "lineage-complete");
      }
    }
    if (opts.json) {
      console.log(JSON.stringify(rollup, null, 2));
      return 0;
    }
    if (manifests.length === 0 && missingDispatchIds.length === 0) {
      console.log(`usage-manifest rollup: no manifests found under ${evidenceRoot}`);
      return 0;
    }
    console.log(renderManifestRollupMarkdown(rollup, {
      top: opts.top,
      sort: opts.sort,
      itemWidth: opts.itemWidth,
      homeDir,
    }));
    if (rollup.lineage) console.log(renderLineageSummaryMarkdown(rollup.lineage));
    return 0;
  }

  if (opts.budgetCheck && !opts.sinceChange) {
    // `--budget-check` without `--since-change` has nothing to evaluate — the
    // budget block below only exists inside the `--since-change` branch. Falling
    // through here would exit 0 with no `budget` key printed, which a caller
    // (or a human reading the exit code alone) cannot distinguish from "checked,
    // nothing exceeded." That is the same fail-open shape the D10 evaluator and
    // `detectMeterReset` both guard against — this is the CLI's own front door.
    console.error("--budget-check requires --since-change <name>");
    return BUDGET_EXIT.UNAVAILABLE;
  }

  if (opts.sinceChange) {
    if (opts.byClass) {
      // The since-change rollup aggregates per-session totals across a
      // checkpoint's session list — it never holds the individual turns
      // groupTurnsByClass needs. Silently ignoring --by-class here would
      // exit 0 with no by-class output and no signal why, which is the
      // same silent-drop shape this change exists to close off elsewhere.
      // Exit code MUST be UNAVAILABLE (2), not 1 — in this CLI, 1 is reserved
      // for BUDGET_EXIT.EXCEEDED (line below); a caller that branches on exit
      // code alone (e.g. a pre-dispatch budget gate) would otherwise read
      // this usage error as "budget exceeded, block" — the exact fail-open
      // conflation the --budget-check-without---since-change guard above
      // already exists to prevent.
      console.error("--by-class is not supported together with --since-change; rerun with --host/--session (or --latest) --by-class instead");
      return BUDGET_EXIT.UNAVAILABLE;
    }
    const checkpoint = readChangeUsageCheckpoint({ changeName: opts.sinceChange });
    if (checkpoint.status !== "ok") {
      // F-4-1 / D7: missing or corrupt checkpoint MUST NOT be conflated with
      // a "some sessions unavailable" partial result — this is a distinct,
      // existing `unavailable` semantic (NFR-2), unchanged by this flag.
      const result = { available: false, since_change: opts.sinceChange, reason: "checkpoint unavailable" };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`since-change=${opts.sinceChange} available: false (reason: checkpoint unavailable)`);
      }
      // DW2 / proposal.md: a missing checkpoint means no threshold can be
      // evaluated at all — this is --budget-check's "unavailable" state,
      // exit-code-distinct from BUDGET_EXIT.OK (nothing checked, not
      // "checked and clean").
      return opts.budgetCheck ? BUDGET_EXIT.UNAVAILABLE : 0;
    }

    const measurementSessions = unionCheckpointMeasurementSessions(checkpoint);
    const rollup = aggregateSinceChangeUsage({
      sessions: measurementSessions,
      changeName: opts.sinceChange,
      collectSessionUsage,
      roots,
      env,
      getSessionTransitions: (session_id) => readSessionChangeTransitions({ session_id }),
    });
    const result = { available: true, since_change: opts.sinceChange, ...rollup };
    if (opts.lineage) {
      const usageOverrides = new Map();
      for (const session of rollup.sessions) {
        if (session.status !== "ok") continue;
        usageOverrides.set(`${session.host}:${session.session_id}`, {
          available: true,
          host: session.host,
          session: session.session_id,
          usage_source: "checkpoint",
          totals: session.totals,
          cost_usd: null,
          usage_source: session.usage_source,
          usage_segments: session.usage_segments ?? [],
          usage_segment_scope: session.usage_segment_scope,
          usage_reconciliation: session.usage_reconciliation,
          usage_reconciliation_scope: session.usage_reconciliation_scope,
          usage_attribution: session.usage_attribution,
          usage_attribution_scope: session.usage_attribution_scope,
          field_availability: {
            input: session.field_availability?.input ?? "available",
            output: session.field_availability?.output ?? "available",
            cache_read: session.field_availability?.cache_read ?? (session.totals.cache_read == null ? "unverified-on-host" : "available"),
            cache_creation: session.field_availability?.cache_creation ?? (session.totals.cache_creation == null ? "unsupported-by-host" : "available"),
            cost_usd: "unsupported-by-host",
          },
          gaps: session.gaps ?? [],
          turns: [],
          terminality: session.bounded_by ? "terminal" : "open",
        });
      }
      const allBounded = rollup.sessions.length > 0 && rollup.sessions.every((session) => session.status === "ok" && session.bounded_by);
      const evidenceRoot = opts.controlEvidenceRoot ?? controlEvidenceRoot(env, process.cwd());
      const externalBundle = collectChangeScopedExternalReviewerSessions({
        evidenceRoot,
        checkpointSessions: measurementSessions,
        changeName: opts.sinceChange,
      });
      result.lineage = createLineageReport({
        measurementRoots: measurementSessions.map((session) => ({
          host: session.host,
          session_id: session.session_id,
          source: session.source === "override" ? "override" : "exact",
        })),
        externalSessions: externalBundle.externalSessions,
        boundary: {
          scope: "current-change",
          attribution_verified: rollup.coverage === "complete" && rollup.attribution_verified === true,
          attributed_session_identities: measurementSessions
            .map((session) => canonicalSessionIdentity(session))
            .filter(Boolean),
          terminality: allBounded ? "terminal" : "open",
        },
        roots,
        env,
        cwdRoots,
        usageOverrides,
        // T10: admission records are the only carrier for responsibility_id /
        // lane / replacement_reason / work_lane_fresh_total; absent dir → the
        // telemetry reports unknown, never 0.
        admissionRecords: loadAdmissionRecords({ repoRoot: process.cwd(), changeName: opts.sinceChange }),
      });
      if (externalBundle.gaps.length > 0) {
        result.lineage.gaps = [...(result.lineage.gaps ?? []), ...externalBundle.gaps];
        // Only named unresolvable reviewer evidence downgrades coverage.
        // True-zero (no same-change overlapping manifests) must stay complete.
        const hasUnresolvableReviewer = externalBundle.gaps.some(
          (g) => g?.name === "external-reviewer-session-unresolvable"
            || g?.name === "external-reviewer-scope-unbound"
            || (typeof g?.name === "string" && g.name.startsWith("reviewer-window-")),
        );
        if (result.lineage.claim?.coverage === "lineage-complete" && hasUnresolvableReviewer) {
          result.lineage.claim.coverage = "lineage-incomplete";
          result.lineage.claim.claims = (result.lineage.claim.claims ?? []).filter(claim => claim !== "lineage-complete");
        }
      }
    }

    let exitCode = 0;
    if (opts.budgetCheck) {
      // D17: the change name is passed EXPLICITLY, never reverse-derived from
      // `usage`. `usage` is a totals rollup and carries no receipt-chain
      // information, so folding the observation into it would both misrepresent
      // that object's ownership and give `cost-budget.mjs` -- a module the brd
      // requires to stay pure -- a reason to grow a filesystem dependency.
      // `--budget-check` already requires `--since-change` (guarded above), so
      // `opts.sinceChange` is non-empty on every path that reaches here.
      //
      // A construction failure of the core module is caught in the same place
      // and for the same reason as a chain-read failure: the caller named a
      // change, so something that should have been readable was not, and that
      // is `unavailable` -- never `ok`, and never a streak of 0.
      let reviewStall;
      try {
        reviewStall = queryReviewStallState({ repoRoot: process.cwd(), changeId: opts.sinceChange });
      } catch {
        reviewStall = { state: "unavailable", streak: null };
      }
      const budget = evaluateCostBudget({ usage: rollup, reviewStall });
      const meterResetSuspected = detectMeterReset({ cwd: process.cwd(), sessions: checkpoint.sessions });
      result.budget = budget;
      result.meter_reset_suspected = meterResetSuspected;
      exitCode = budget.exceeded ? BUDGET_EXIT.EXCEEDED : BUDGET_EXIT.OK;
      // D23/D24: an exceeded budget resumes ONLY through the user's exact-set
      // DEVPRO_COST_BUDGET_OVERRIDE (same resolver as the post-PR hook;
      // effective only after its durable append). The raw budget_state stays
      // printed; budget_state_effective excludes the approved thresholds and
      // is what a classify-bounded caller passes as budgetState.
      if (budget.exceeded && typeof env?.DEVPRO_COST_BUDGET_OVERRIDE === "string" && env.DEVPRO_COST_BUDGET_OVERRIDE !== "") {
        const override = resolveCostBudgetOverride({
          envValue: env.DEVPRO_COST_BUDGET_OVERRIDE,
          changeName: opts.sinceChange,
          exceededThresholds: budget.exceeded_thresholds,
          cwd: process.cwd(),
          sessionId: captureTlHostSession(env)?.session_id,
          headRefOid: resolveHeadRefOid(process.cwd()),
        });
        result.budget_override = override;
        if (override.effective) {
          result.budget_state_effective = deriveEffectiveBudgetState(budget, override.declared_thresholds);
          exitCode = BUDGET_EXIT.OK;
        }
      }
    }

    if (opts.json) {
      // F-84390750: `sanitizeResultItems` does not apply to this branch's
      // result shape (it maps `result.turns[].item`, but `--since-change`
      // returns `sessions[]` with a per-entry `reason`, not `turns`) — this
      // early return bypassed the loop below entirely, so an unavailable
      // session's raw `ensureHostRoot` path (e.g. "host root not found:
      // /Users/<user>/.claude") reached stdout unmasked. Sanitize inline
      // here with the same `sanitizeHomeAndCwd` call and safety rationale as
      // the non-JSON loop below: bare `sanitizeHomeAndCwd` does not restore
      // the "<enc-cwd>/<last>" sentinel, which is safe only because
      // `ensureHostRoot`'s reason is always the `/`-joined root path, never
      // the dash-joined encoded-cwd form the sentinel branch matches.
      const sanitizedResult = {
        ...result,
        sessions: result.sessions.map((s) =>
          s.status === "unavailable" ? { ...s, reason: sanitizeHomeAndCwd(s.reason, homeDir) } : s,
        ),
      };
      console.log(JSON.stringify(sanitizedResult, null, 2));
      return exitCode;
    }
    console.log(`since-change=${opts.sinceChange} coverage=${rollup.coverage} attribution_verified=${rollup.attribution_verified}`);
    console.log(
      `totals: input=${rollup.totals.input} output=${rollup.totals.output} ` +
        `cache_read=${rollup.totals.cache_read} cache_creation=${rollup.totals.cache_creation} ` +
        `model_time_ms=${rollup.totals.model_time_ms}`,
    );
    for (const s of rollup.sessions) {
      if (s.status === "unavailable") {
        // F-f4a596a7: s.reason can carry ensureHostRoot's raw absolute host-root
        // path (e.g. "host root not found: /Users/<user>/.claude") — this
        // `--since-change` result shape has no sanitizeResultItems coverage at
        // all (that helper only runs in the separate `--host`/`--session`
        // JSON path further below, and maps a different `turns[].item` shape
        // this branch doesn't have), so mask it here; the `--json` early
        // return above (F-84390750) applies the same call to the same field
        // independently, since it returns before this loop ever runs. Bare
        // sanitizeHomeAndCwd (unlike sanitizeItem) does not restore its
        // "<enc-cwd>/<last>" sentinel to literal `<`/`>`; safe here because
        // ensureHostRoot's reason is always the `/`-joined root path, never
        // the dash-joined encoded-cwd form the sentinel branch matches.
        console.log(`  session=${s.session_id} host=${s.host} unavailable (reason: ${sanitizeHomeAndCwd(s.reason, homeDir)})`);
      } else {
        console.log(
          `  session=${s.session_id} host=${s.host} input=${s.totals.input} output=${s.totals.output} ` +
            `cache_read=${s.totals.cache_read} cache_creation=${s.totals.cache_creation} ` +
            `model_time_ms=${s.model_time_ms} duration_missing_turn_count=${s.duration_missing_turn_count} ` +
            `source=${s.source} usage_source=${s.usage_source ?? "not-reported"} ` +
            `reconciliation=${s.usage_reconciliation?.status ?? "unknown"} ` +
            `attribution=${s.usage_attribution?.status ?? "unknown"} ` +
            `unassigned=${s.usage_attribution?.unassigned_response_count ?? 0}`,
        );
      }
    }
    if (result.lineage) console.log(renderLineageSummaryMarkdown(result.lineage));
    if (opts.budgetCheck) {
      const b = result.budget;
      console.log(`budget: exceeded=${b.exceeded} exceeded_thresholds=${b.exceeded_thresholds.join(",") || "none"}`);
      console.log(`budget_state: ${b.budget_state} coverage=${b.coverage}`);
      for (const [key, t] of Object.entries(b.thresholds)) {
        console.log(`  ${key}: state=${t.state} value=${t.value} limit=${t.limit}`);
      }
      console.log(`meter_reset_suspected: ${result.meter_reset_suspected}`);
      if (result.budget_override) {
        const o = result.budget_override;
        console.log(`override: ${o.effective ? "effective" : "not-effective"} reason=${o.reason} declared=${(o.declared_thresholds ?? []).join(",") || "none"}`);
        if (o.effective) console.log(`budget_state_effective: ${result.budget_state_effective}`);
        // D5/D12 (fix-second-review-loop-friction): a legacy `round`/
        // `review_round` declaration resolves `unknown_threshold_key` with a
        // `hint` attached (cost-budget-override.mjs's `ROUND_EXTENSION_HINT`).
        // The `--json` path already carries this for free (`o` is
        // `result.budget_override` verbatim); only this text renderer needs
        // the explicit line.
        else if (typeof o.hint === "string") console.log(`hint: ${o.hint}`);
      }
    }
    return exitCode;
  }

  const runOpts = { opts, roots, homeDir, env, cwdRoots };

  let results;
  if (opts.host === "auto") {
    const both = [runHost("claude-code", runOpts), runHost("codex", runOpts)];
    const available = both.filter((r) => r.available);
    results = available.length > 0 ? available : both;
  } else {
    results = [runHost(opts.host, runOpts)];
  }

  const directLineage = opts.lineage
    ? createLineageReport({
        measurementRoots: results.filter((result) => result.available && result.session).map((result) => ({
          host: result.host,
          session_id: result.session,
          source: result.source,
        })),
        boundary: { scope: "session-wide" },
        roots,
        env,
        cwdRoots,
      })
    : null;

  if (opts.json) {
    const sanitized = results.map((r) => {
      const item = sanitizeResultItems(r, { homeDir, itemWidth: opts.itemWidth });
      // by_class is derived from the pre-sanitize turns (groupTurnsByClass
      // reads tokens/actor/origin_class, never the free-text `item` field
      // sanitizeResultItems rewrites), keeping it independent of sanitize's
      // output shape.
      return opts.byClass && item.available ? { ...item, by_class: groupTurnsByClass(r.turns) } : item;
    });
    const payload = sanitized.length === 1
      ? (directLineage ? { ...sanitized[0], lineage: directLineage } : sanitized[0])
      : (directLineage ? { results: sanitized, lineage: directLineage } : sanitized);
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  for (const result of results) {
    if (!result.available) {
      // F-f4a596a7: same rationale as the --since-change branch above — this
      // non-JSON branch has no sanitizeResultItems coverage.
      console.log(`host=${result.host} available: false (reason: ${sanitizeHomeAndCwd(result.reason, homeDir)})`);
      continue;
    }
    console.log(`host=${result.host}`);
    const renderedResult = directLineage
      ? {
          ...result,
          gaps: [
            ...(result.gaps ?? []),
            ...directLineage.gaps.map((gap) => ({ name: gap.name })),
          ],
        }
      : result;
    console.log(
      renderMarkdownLedger(renderedResult, { top: opts.top, sort: opts.sort, itemWidth: opts.itemWidth, homeDir }),
    );
    if (opts.byClass) {
      console.log("");
      console.log(renderByClassSummary(groupTurnsByClass(result.turns)));
    }
    console.log("");
  }
  if (directLineage) {
    console.log(renderLineageSummaryMarkdown(directLineage, { includeGaps: false }));
    console.log("");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
