/**
 * session-usage-manifest.mjs
 *
 * Correlates second-review / design-gate dispatches with the host session ids
 * that actually incurred token spend (TL host + reviewer subprocess), so Recap
 * Token 回顧 can roll up cross-review attribution without manual session hunting.
 *
 * Written beside control-evidence dispatch.json as usage-manifest.json.
 * Fail-open: manifest write errors MUST NOT block projection completion.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fsyncDirectory } from "./durable-fs.mjs";
import { assertDispatchId, isValidDispatchId } from "./control-evidence-dispatch-id.mjs";
import { assertDispatchEvidenceAvailable, withDispatchEvidenceSnapshot } from "../hooks/lib/second-review-control-evidence.mjs";
import { USAGE_MANIFEST_FILE, USAGE_MANIFEST_SCHEMA } from "./session-usage-manifest-contract.mjs";
import { formatDisplayNumber, isValidNeutralSessionIdShape, isValidSessionIdShape, renderMarkdownLedger, sanitizeResultItems } from "./session-token-usage.mjs";

export { USAGE_MANIFEST_FILE, USAGE_MANIFEST_SCHEMA, isUsageManifestAtomicTempFileName } from "./session-usage-manifest-contract.mjs";
const USAGE_MANIFEST_RETENTION_DIRECTORY = ".usage-manifest-retention";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstValidSessionId(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (isValidSessionIdShape(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Capture the TL host session from process env (Codex or Claude Code).
 */
function captureTlHostSessionFromCandidates(host, candidates) {
  for (const [source, candidate] of candidates) {
    const sessionId = firstValidSessionId([candidate]);
    if (sessionId) {
      return {
        role: "tl-host",
        host,
        session_id: sessionId,
        source,
      };
    }
  }
  return null;
}

export function captureTlHostSession(env = process.env) {
  const codex = captureTlHostSessionFromCandidates("codex", [
    ["env:CODEX_SESSION_ID", env?.CODEX_SESSION_ID],
    ["env:CODEX_THREAD_ID", env?.CODEX_THREAD_ID],
  ]);
  if (codex) return codex;

  const claude = captureTlHostSessionFromCandidates("claude-code", [
    ["env:CLAUDE_SESSION_ID", env?.CLAUDE_SESSION_ID],
    ["env:CLAUDE_CONVERSATION_ID", env?.CLAUDE_CONVERSATION_ID],
    ["env:DEVPRO_POST_PR_COMPLETION_SESSION_ID", env?.DEVPRO_POST_PR_COMPLETION_SESSION_ID],
    // Appended last (not reordered ahead of the above): the real Claude Code
    // CLI host process only ever sets CLAUDE_CODE_SESSION_ID — none of the
    // three vars above are ever populated in that host (F-a7c19d2e live
    // probe). Existing tests seed CLAUDE_SESSION_ID explicitly and must keep
    // winning via array order, so this candidate is additive-only.
    ["env:CLAUDE_CODE_SESSION_ID", env?.CLAUDE_CODE_SESSION_ID],
  ]);
  if (claude) return claude;

  // Provider-neutral fallback (strengthen-host-session-neutrality): any runtime
  // adapter MAY declare its session via DEVPRO_HOST_SESSION_ID so identity-only
  // consumers (cost-budget override records, change-usage checkpoints,
  // dispatch manifests) are not restricted to claude-code/codex hosts. This
  // path uses the neutral bounded shape and MUST NOT feed transcript path
  // assembly (see isValidNeutralSessionIdShape).
  const neutralCandidate = typeof env?.DEVPRO_HOST_SESSION_ID === "string"
    ? env.DEVPRO_HOST_SESSION_ID.trim()
    : "";
  if (isValidNeutralSessionIdShape(neutralCandidate)) {
    return {
      role: "tl-host",
      host: "host-neutral",
      session_id: neutralCandidate,
      source: "env:DEVPRO_HOST_SESSION_ID",
    };
  }
  return null;
}

export function extractCodexReviewerSessionCandidate(event) {
  if (!isPlainObject(event)) return null;
  if (event.type === "session_meta" && isValidSessionIdShape(event?.payload?.id)) {
    return {
      session_id: event.payload.id,
      source: "stream-json:session_meta.payload.id",
    };
  }
  if (event.type === "thread.started") {
    const threadId = event.thread_id ?? event.session_id;
    if (isValidSessionIdShape(threadId)) {
      return {
        session_id: threadId,
        source: event.thread_id
          ? "stream-json:thread.started.thread_id"
          : "stream-json:thread.started.session_id",
      };
    }
  }
  return null;
}

/**
 * Extract reviewer subprocess session id from bounded projection evidence.
 */
export function extractReviewerSessionEntry(boundedEvidence, reviewerTool) {
  if (reviewerTool === "claude") {
    const terminal = boundedEvidence?.terminal;
    if (terminal?.type === "result" && isValidSessionIdShape(terminal.session_id)) {
      return {
        role: "reviewer",
        host: "claude-code",
        session_id: terminal.session_id,
        source: "stream-json:result.session_id",
      };
    }
    for (const event of boundedEvidence?.structuredEvents ?? []) {
      if (event?.type === "result" && isValidSessionIdShape(event.session_id)) {
        return {
          role: "reviewer",
          host: "claude-code",
          session_id: event.session_id,
          source: "stream-json:result.session_id",
        };
      }
    }
    return null;
  }
  if (reviewerTool === "codex") {
    for (const event of boundedEvidence?.stdoutStructuredEvents ?? []) {
      const candidate = extractCodexReviewerSessionCandidate(event);
      if (candidate) return { role: "reviewer", host: "codex", ...candidate };
    }
    const capturedSession = boundedEvidence?.codexManifestSessionEvidence;
    if (isValidSessionIdShape(capturedSession?.session_id)
      && ["stream-json:session_meta.payload.id", "stream-json:thread.started.thread_id", "stream-json:thread.started.session_id"]
        .includes(capturedSession.source)) {
      return {
        role: "reviewer",
        host: "codex",
        session_id: capturedSession.session_id,
        source: capturedSession.source,
      };
    }
  }
  return null;
}

const REVIEWER_USAGE_SNAPSHOT_SOURCE = "reviewer-manifest:turn.completed.usage";

function codexReviewUsageSnapshot(boundedEvidence) {
  const event = [...(boundedEvidence?.stdoutStructuredEvents ?? [])]
    .reverse()
    .find((item) => item?.type === "turn.completed" && isPlainObject(item.usage));
  const usage = event?.usage;
  if (!usage) return null;
  const { input_tokens: inputTokens, cached_input_tokens: cachedInputTokens, output_tokens: outputTokens } = usage;
  if (![inputTokens, cachedInputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
    || cachedInputTokens > inputTokens) return null;
  return {
    totals: {
      input: inputTokens - cachedInputTokens,
      output: outputTokens,
      cache_read: cachedInputTokens,
      cache_creation: null,
    },
    source: REVIEWER_USAGE_SNAPSHOT_SOURCE,
  };
}

export function usageSnapshotToCollectedUsage(snapshot, { host, sessionId } = {}) {
  if (!isPlainObject(snapshot) || snapshot.source !== REVIEWER_USAGE_SNAPSHOT_SOURCE || !isPlainObject(snapshot.totals)) return null;
  const totals = snapshot.totals;
  if (!["input", "output", "cache_read", "cache_creation"].every((key) => (
    totals[key] === null || (Number.isSafeInteger(totals[key]) && totals[key] >= 0)
  ))) return null;
  if (!["input", "output", "cache_read"].every((key) => typeof totals[key] === "number")) return null;
  return {
    available: true,
    host,
    session: sessionId,
    totals: { ...totals },
    source: snapshot.source,
    reviewer_source: snapshot.source,
    cost_usd: null,
    field_availability: {
      input: "available",
      output: "available",
      cache_read: "available",
      cache_creation: "unsupported-by-host",
      cost_usd: "unsupported-by-host",
    },
    gaps: [],
    turns: [],
  };
}

function mergeSessionEntries(existing, incoming) {
  const merged = [...(existing ?? [])];
  for (const entry of incoming ?? []) {
    if (!entry?.session_id || !entry?.host || !entry?.role) continue;
    const duplicate = merged.some(
      (item) => item.role === entry.role
        && item.host === entry.host
        && item.session_id === entry.session_id,
    );
    if (!duplicate) merged.push(entry);
  }
  return merged;
}

/**
 * Discover control-evidence usage manifests for a change-scoped lineage report.
 * Only manifests whose tl-host session overlaps checkpoint measurement roots
 * count as same-change reviewer evidence. When checkpoint has no bindable
 * session_id but reviewer manifests exist, emit `external-reviewer-scope-unbound`
 * (never a quiet false zero). Non-overlapping foreign manifests with a nonempty
 * checkpoint stay true-zero without a gap.
 */
function manifestHasReviewerEvidence(manifest) {
  const sessions = manifest?.sessions ?? [];
  const gaps = manifest?.gaps ?? [];
  return sessions.some((session) => session?.role === "reviewer")
    || gaps.some((gap) => gap?.name === "reviewer-session-missing")
    || (manifest?.paged_coverage?.invoked_windows?.length ?? 0) > 0;
}

function unboundExternalReviewerScopeGap({ changeName, detail, dispatchId = null } = {}) {
  return {
    name: "external-reviewer-scope-unbound",
    dispatch_id: dispatchId,
    detail,
    change_name: changeName ?? null,
  };
}

export function collectChangeScopedExternalReviewerSessions({
  evidenceRoot,
  checkpointSessions = [],
  changeName = null,
} = {}) {
  const gaps = [];
  const externalSessions = [];
  if (!evidenceRoot) {
    return { externalSessions, gaps };
  }
  const { manifests } = discoverUsageManifests({ rootDir: evidenceRoot });
  if (manifests.length === 0) {
    return { externalSessions, gaps };
  }
  const checkpointIds = new Set(
    (checkpointSessions ?? [])
      .map((session) => session?.session_id)
      .filter((id) => typeof id === "string" && id.length > 0),
  );
  const reviewerEvidenceManifests = manifests.filter(manifestHasReviewerEvidence);
  // Reviewer manifests exist but no checkpoint session_id to bind (e.g. Cursor
  // host with no resolvable session_id). Named gap — never quiet false zero.
  if (checkpointIds.size === 0) {
    if (reviewerEvidenceManifests.length > 0) {
      gaps.push(unboundExternalReviewerScopeGap({
        changeName,
        detail: "reviewer manifest evidence exists but checkpoint has no bindable tl-host session_id",
        dispatchId: reviewerEvidenceManifests[0]?.dispatch_id ?? null,
      }));
    }
    return { externalSessions, gaps };
  }
  const overlapping = [];
  for (const manifest of manifests) {
    const tlHosts = (manifest.sessions ?? []).filter((session) => session.role === "tl-host");
    const overlaps = tlHosts.some((session) => checkpointIds.has(session.session_id));
    if (overlaps) overlapping.push(manifest);
  }
  // Foreign (non-overlapping) manifests stay out of scope: true-zero without a
  // gap when checkpoint ids exist but none match. The empty-checkpoint path
  // above is what names unbound reviewer evidence.
  if (overlapping.length === 0) {
    return { externalSessions, gaps };
  }
  for (const manifest of overlapping) {
    gaps.push(...manifestCoverageGaps(manifest).filter(gap => typeof gap?.name === "string" && gap.name.startsWith("reviewer-window-")).map(gap => ({ ...gap, dispatch_id: manifest.dispatch_id, change_name: changeName ?? null })));
    const reviewerSessions = (manifest.sessions ?? []).filter((session) => session.role === "reviewer");
    const reviewerGaps = (manifest.gaps ?? []).filter((gap) => gap.name === "reviewer-session-missing");
    if (reviewerSessions.length === 0 && reviewerGaps.length > 0) {
      for (const gap of reviewerGaps) {
        gaps.push({
          name: "external-reviewer-session-unresolvable",
          dispatch_id: manifest.dispatch_id,
          detail: gap.detail ?? "reviewer session missing in manifest",
          change_name: changeName ?? null,
        });
      }
      continue;
    }
    if (reviewerSessions.length === 0) continue;
    for (const session of reviewerSessions) {
      if (!session.session_id || !session.host) {
        gaps.push({
          name: "external-reviewer-session-unresolvable",
          dispatch_id: manifest.dispatch_id,
          detail: "reviewer manifest row missing session_id or host",
          change_name: changeName ?? null,
        });
        continue;
      }
      externalSessions.push({
        host: session.host,
        session_id: session.session_id,
        dispatch_id: manifest.dispatch_id,
        source: "exact",
        ...(session.host === "codex"
          ? { usage: usageSnapshotToCollectedUsage(session.usage_snapshot, { host: session.host, sessionId: session.session_id }) }
          : {}),
      });
    }
  }
  return { externalSessions, gaps };
}

export function sessionUsageKey(session) {
  return `${session.host}:${session.session_id}`;
}

function reconcileManifestGaps(sessions, gaps) {
  const hasTlHost = (sessions ?? []).some((session) => session.role === "tl-host");
  const hasReviewer = (sessions ?? []).some((session) => session.role === "reviewer");
  return (gaps ?? []).filter((gap) => {
    if (gap.name === "tl-host-session-missing" && hasTlHost) return false;
    if (gap.name === "reviewer-session-missing" && hasReviewer) return false;
    return true;
  });
}

// Coverage follows runner invocations, independently of deduplicated session rows.
function pagedCoverageGaps(manifest) {
  const coverage = manifest.paged_coverage;
  if (coverage === undefined) return [{ name: "reviewer-window-coverage-unknown", detail: "historical manifest has no invocation coverage metadata" }];
  if (!isPlainObject(coverage) || !Number.isSafeInteger(coverage.planned_window_count)
    || coverage.planned_window_count < 1 || !Array.isArray(coverage.invoked_windows)
    || coverage.invoked_window_count !== coverage.invoked_windows.length) {
    return [{ name: "reviewer-window-coverage-invalid", detail: "invalid paged invocation coverage" }];
  }
  const gaps = [];
  const seen = new Set();
  for (const window of coverage.invoked_windows) {
    const index = window?.index;
    if (!Number.isSafeInteger(index) || index < 1 || index > coverage.invoked_window_count || seen.has(index)) {
      gaps.push({ name: "reviewer-window-coverage-invalid", detail: "invalid or repeated invoked window index" });
      continue;
    }
    seen.add(index);
    if (!isValidSessionIdShape(window.session_id) || !["codex", "claude-code"].includes(window.host)) {
      gaps.push({ name: "reviewer-window-session-missing", window_index: index, detail: `no trustworthy reviewer session for invoked window ${index}` });
    } else if (!(manifest.sessions ?? []).some(row => row.role === "reviewer" && row.host === window.host && row.session_id === window.session_id)) {
      gaps.push({ name: "reviewer-window-row-missing", window_index: index, detail: `no reviewer row for invoked window ${index}` });
    }
  }
  return gaps;
}

function manifestCoverageGaps(manifest) {
  const gaps = [...(manifest.gaps ?? []), ...pagedCoverageGaps(manifest)];
  return gaps.filter((gap, index) => gaps.findIndex(item => item.name === gap.name && item.window_index === gap.window_index) === index);
}

function sanitizeCollectedUsage(usage, { homeDir, itemWidth } = {}) {
  if (!usage?.available) return usage;
  return sanitizeResultItems(usage, { homeDir, itemWidth });
}

/**
 * Build a usage manifest record for one dispatch.
 */
export function buildUsageManifest({
  context,
  dispatchRecord,
  boundedEvidence = null,
  env = process.env,
  reviewerModel = null,
  pagedCoverage = null,
  invokedWindowIndex = null,
}) {
  const gaps = [];
  const sessions = [];
  const tlHost = captureTlHostSession(env);
  if (tlHost) sessions.push(tlHost);
  else gaps.push({ name: "tl-host-session-missing", detail: "no TL host session id in env" });

  const reviewerTool = context?.reviewer_cli_recipe?.tool ?? null;
  const reviewerEntry = reviewerTool
    ? extractReviewerSessionEntry(boundedEvidence, reviewerTool)
    : null;
  if (reviewerEntry) {
    const usageSnapshot = reviewerTool === "codex" ? codexReviewUsageSnapshot(boundedEvidence) : null;
    sessions.push({
      ...reviewerEntry,
      ...(usageSnapshot ? { usage_snapshot: usageSnapshot } : {}),
      ...(reviewerModel ? { reviewer_model: reviewerModel } : {}),
      ...(reviewerTool ? { reviewer_tool: reviewerTool } : {}),
    });
  } else if (reviewerTool) {
    gaps.push({
      name: "reviewer-session-missing",
      detail: `no reviewer session id in ${reviewerTool} stream evidence`,
    });
  }

  const coverage = pagedCoverage ? {
    ...pagedCoverage,
    invoked_windows: [
      ...(pagedCoverage.invoked_windows ?? []),
      ...(invokedWindowIndex === null ? [] : [{ index: invokedWindowIndex, host: reviewerEntry?.host ?? null, session_id: reviewerEntry?.session_id ?? null }]),
    ],
  } : null;
  if (coverage) coverage.invoked_window_count = coverage.invoked_windows.length;
  const manifest = {
    schema: USAGE_MANIFEST_SCHEMA,
    dispatch_id: dispatchRecord.dispatch_id,
    attempt_id: dispatchRecord.attempt_id,
    repository_slug: dispatchRecord.repository_slug,
    head_ref_oid: dispatchRecord.head_ref_oid,
    mode: context?.mode ?? "unknown",
    review_target: context?.target ?? "unknown",
    recorded_at: new Date().toISOString(),
    sessions: mergeSessionEntries([], sessions),
    gaps,
    ...(coverage ? { paged_coverage: coverage } : {}),
  };
  if (coverage) manifest.gaps = manifestCoverageGaps(manifest);
  return manifest;
}

export function usageManifestPath(rootDir, dispatchId) {
  assertDispatchId(dispatchId);
  return path.join(path.resolve(rootDir), dispatchId, USAGE_MANIFEST_FILE);
}

function retainedUsageManifestPath(rootDir, dispatchId) {
  assertDispatchId(dispatchId);
  return path.join(path.resolve(rootDir), USAGE_MANIFEST_RETENTION_DIRECTORY, `${dispatchId}.json`);
}

function writeUsageManifestAtomically(filePath, record) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.usage-manifest.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function readManifestFile(filePath, dispatchId) {
  let record;
  try {
    record = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(record)
    || record.schema !== USAGE_MANIFEST_SCHEMA
    || record.dispatch_id !== dispatchId) return null;
  return record;
}

function ensureUsageManifestRetentionDirectory(directory) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("usage manifest retention directory must be a real directory");
  }
  if (process.platform !== "win32" && (status.mode & 0o777) !== 0o700) {
    throw new Error("usage manifest retention directory must have permissions 0o700");
  }
}

/**
 * Write or merge usage-manifest.json under a dispatch evidence directory.
 * Idempotent merge: later writes add sessions without dropping prior entries.
 */
export function writeUsageManifest({ rootDir, manifest }) {
  if (!manifest?.dispatch_id) {
    throw new Error("usage manifest requires dispatch_id");
  }
  assertDispatchId(manifest.dispatch_id);
  const resolvedRoot = path.resolve(rootDir);
  mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  return withDispatchEvidenceSnapshot({ rootDir: resolvedRoot }, () => {
    // Keep the authority check and every member/retention mutation in one capacity lock.
    assertDispatchEvidenceAvailable({ rootDir: resolvedRoot, dispatchId: manifest.dispatch_id });
    const directory = path.dirname(usageManifestPath(resolvedRoot, manifest.dispatch_id));
    const retentionDirectory = path.join(resolvedRoot, USAGE_MANIFEST_RETENTION_DIRECTORY);
    ensureUsageManifestRetentionDirectory(retentionDirectory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filePath = usageManifestPath(resolvedRoot, manifest.dispatch_id);
    const retainedPath = retainedUsageManifestPath(resolvedRoot, manifest.dispatch_id);
    const existing = readUsageManifest({ rootDir: resolvedRoot, dispatchId: manifest.dispatch_id });
    const mergedSessions = existing
      ? mergeSessionEntries(existing.sessions, manifest.sessions)
      : manifest.sessions;
    const mergedGaps = reconcileManifestGaps(
      mergedSessions,
      existing
        ? [...(existing.gaps ?? []), ...(manifest.gaps ?? [])].filter(
          (gap, index, all) => all.findIndex((item) => item.name === gap.name && item.window_index === gap.window_index) === index,
        )
        : (manifest.gaps ?? []),
    );
    const merged = existing
      ? {
          ...existing,
          ...manifest,
          sessions: mergedSessions,
          gaps: mergedGaps,
        }
      : {
          ...manifest,
          sessions: mergedSessions,
          gaps: reconcileManifestGaps(mergedSessions, manifest.gaps ?? []),
        };
    // Recompute derived row gaps against the merged sessions, but never heal a
    // different window's missing identity or a failed persistence boundary.
    if (merged.paged_coverage !== undefined) merged.gaps = manifestCoverageGaps({ ...merged, gaps: merged.gaps.filter(gap => gap.name !== "reviewer-window-row-missing") });
    writeUsageManifestAtomically(filePath, merged);
    writeUsageManifestAtomically(retainedPath, merged);
    return { path: filePath, record: merged };
  });
}

export function readUsageManifest({ rootDir, dispatchId }) {
  assertDispatchId(dispatchId);
  const filePath = usageManifestPath(rootDir, dispatchId);
  if (existsSync(filePath)) {
    const visible = readManifestFile(filePath, dispatchId);
    if (visible) return visible;
  }
  const retentionDirectory = path.join(path.resolve(rootDir), USAGE_MANIFEST_RETENTION_DIRECTORY);
  try {
    if (!lstatSync(retentionDirectory).isDirectory()) return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const retainedPath = retainedUsageManifestPath(rootDir, dispatchId);
  try {
    if (!lstatSync(retainedPath).isFile()) return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return readManifestFile(retainedPath, dispatchId);
}

function listDispatchDirectories(rootDir) {
  const resolved = path.resolve(rootDir);
  if (!existsSync(resolved)) return [];
  const ids = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("dispatch-") && isValidDispatchId(entry.name))
    .map((entry) => entry.name);
  const retentionDirectory = path.join(resolved, USAGE_MANIFEST_RETENTION_DIRECTORY);
  let retentionStat;
  try {
    retentionStat = lstatSync(retentionDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return [...new Set(ids)];
  }
  if (!retentionStat.isDirectory()) return [...new Set(ids)];
  for (const entry of readdirSync(retentionDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const dispatchId = entry.name.slice(0, -5);
    if (isValidDispatchId(dispatchId)) ids.push(dispatchId);
  }
  return [...new Set(ids)];
}

/**
 * Discover usage manifests under a control-evidence root.
 */
export function discoverUsageManifests({
  rootDir,
  dispatchIds = null,
  repositorySlug = null,
  headRefOidPrefix = null,
} = {}) {
  const ids = dispatchIds?.length
    ? [...new Set(dispatchIds)]
    : listDispatchDirectories(rootDir);
  const manifests = [];
  const missingDispatchIds = [];
  const explicitRequest = Boolean(dispatchIds?.length);
  for (const dispatchId of ids) {
    assertDispatchId(dispatchId);
    const record = readUsageManifest({ rootDir, dispatchId });
    if (!record) {
      if (explicitRequest) missingDispatchIds.push(dispatchId);
      continue;
    }
    if (repositorySlug && record.repository_slug !== repositorySlug) continue;
    if (headRefOidPrefix && !String(record.head_ref_oid ?? "").startsWith(headRefOidPrefix)) {
      continue;
    }
    manifests.push(record);
  }
  manifests.sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)));
  return { manifests, missingDispatchIds };
}

const ROLLUP_TOTAL_KEYS = ["input", "output", "cache_read", "cache_creation"];

function createRollupTotalSignals() {
  return Object.fromEntries(ROLLUP_TOTAL_KEYS.map((key) => [key, { sawNumber: false, sawNull: false }]));
}

function noteRollupTotalSignal(signals, totals) {
  for (const key of ROLLUP_TOTAL_KEYS) {
    const value = totals?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      signals[key].sawNumber = true;
    } else if (value === null) {
      signals[key].sawNull = true;
    }
  }
}

function finalizeRollupTotals(signals) {
  const totals = Object.fromEntries(ROLLUP_TOTAL_KEYS.map((key) => [key, null]));
  const gaps = [];
  for (const key of ROLLUP_TOTAL_KEYS) {
    const { sawNumber, sawNull } = signals[key];
    if (sawNull) {
      totals[key] = null;
      if (sawNumber) {
        gaps.push({
          name: `rollup-${key.replaceAll("_", "-")}-partial`,
          detail: `mixed null and numeric ${key} across included sessions; aggregate withheld`,
        });
      }
      continue;
    }
    if (sawNumber) {
      totals[key] = signals[key].sum;
    }
  }
  return { totals, gaps };
}

function addNumericTotals(target, source) {
  for (const key of ROLLUP_TOTAL_KEYS) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}

function formatRollupTotalValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatDisplayNumber(value);
  }
  return "—";
}

function collectManifestSessionUsage({
  manifest,
  collectSessionUsage,
  roots,
  env,
  cwdRoots,
  homeDir,
  itemWidth,
}) {
  const dispatchSessions = [];
  for (const session of manifest.sessions ?? []) {
    if (session.host !== "claude-code" && session.host !== "codex") {
      // Provider-neutral host: no transcript telemetry exists, so report a
      // named gap instead of silently reading one host's root for another
      // (strengthen-host-session-neutrality).
      dispatchSessions.push({
        manifestSession: session,
        usage: {
          available: false,
          host: session.host,
          session_id: session.session_id,
          reason: "host-neutral-no-telemetry",
        },
      });
      continue;
    }
    const hostRoot = session.host === "claude-code" ? roots.claudeRoot : roots.codexRoot;
    let collected;
    try {
      collected = sanitizeCollectedUsage(collectSessionUsage({
        host: session.host,
        root: hostRoot,
        sessionId: session.session_id,
        cwdRoots,
        env,
      }), { homeDir, itemWidth });
    } catch {
      collected = { available: false, host: session.host, session_id: session.session_id, reason: "session-usage-read-failed" };
    }
    const snapshot = session.role === "reviewer" && session.host === "codex"
      ? usageSnapshotToCollectedUsage(session.usage_snapshot, { host: session.host, sessionId: session.session_id })
      : null;
    const usage = collected?.available
      ? (session.role === "reviewer" && session.host === "codex" ? { ...collected, reviewer_source: "transcript" } : collected)
      : (snapshot ?? collected);
    dispatchSessions.push({
      manifestSession: session,
      usage,
    });
  }
  return {
    manifest,
    sessions: dispatchSessions,
  };
}

/**
 * Roll up token usage for one or more manifests.
 */
export function rollupManifestUsage({
  manifests,
  missingDispatchIds = [],
  collectSessionUsage,
  roots,
  env = process.env,
  cwdRoots = [],
  homeDir,
  itemWidth,
} = {}) {
  const uniqueManifests = [];
  const seenDispatchIds = new Set();
  for (const manifest of manifests) {
    const dispatchId = manifest?.dispatch_id;
    if (typeof dispatchId === "string" && dispatchId.length > 0) {
      if (seenDispatchIds.has(dispatchId)) continue;
      seenDispatchIds.add(dispatchId);
    }
    uniqueManifests.push(manifest);
  }
  const dispatches = uniqueManifests.map((manifest) => collectManifestSessionUsage({
    manifest,
    collectSessionUsage,
    roots,
    env,
    cwdRoots,
    homeDir,
    itemWidth,
  }));
  const totalSignals = createRollupTotalSignals();
  for (const key of ROLLUP_TOTAL_KEYS) totalSignals[key].sum = 0;
  const seenSessionKeys = new Set();
  const uniqueSessionUsage = [];
  let costUsdSum = 0;
  let costUsdCount = 0;
  const gaps = [];
  for (const dispatchId of missingDispatchIds ?? []) {
    gaps.push({
      name: "usage-manifest-missing",
      detail: `no usage-manifest.json for requested dispatch ${dispatchId}`,
      dispatch_id: dispatchId,
    });
  }
  const dedupedSessions = [];
  for (const dispatch of dispatches) {
    for (const { manifestSession, usage } of dispatch.sessions) {
      if (!usage.available) {
        gaps.push({
          name: "manifest-session-unavailable",
          detail: `${manifestSession.role}/${manifestSession.host}/${manifestSession.session_id}: ${usage.reason}`,
        });
        continue;
      }
      const sessionKey = sessionUsageKey(manifestSession);
      if (seenSessionKeys.has(sessionKey)) {
        dedupedSessions.push({
          ...manifestSession,
          dispatch_id: dispatch.manifest.dispatch_id,
        });
        continue;
      }
      seenSessionKeys.add(sessionKey);
      uniqueSessionUsage.push({
        host: manifestSession.host,
        session_id: manifestSession.session_id,
        role: manifestSession.role,
        dispatch_id: dispatch.manifest.dispatch_id,
        usage,
      });
      noteRollupTotalSignal(totalSignals, usage.totals);
      for (const key of ROLLUP_TOTAL_KEYS) {
        const value = usage.totals?.[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          totalSignals[key].sum += value;
        }
      }
      for (const gap of usage.gaps ?? []) {
        gaps.push({
          ...gap,
          session: sessionKey,
          dispatch_id: dispatch.manifest.dispatch_id,
        });
      }
      if (typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd)) {
        costUsdSum += usage.cost_usd;
        costUsdCount += 1;
      }
    }
    for (const gap of manifestCoverageGaps(dispatch.manifest)) {
      gaps.push({ ...gap, dispatch_id: dispatch.manifest.dispatch_id });
    }
  }
  const finalizedTotals = finalizeRollupTotals(totalSignals);
  const arithmeticTotals = finalizedTotals.totals;
  for (const gap of finalizedTotals.gaps) {
    if (!gaps.some((item) => item.name === gap.name)) gaps.push(gap);
  }
  if (dedupedSessions.length > 0) {
    gaps.push({
      name: "rollup-session-deduped",
      detail: `${dedupedSessions.length} repeated host+session_id entr${dedupedSessions.length === 1 ? "y" : "ies"} excluded from arithmetic totals`,
    });
  }
  return {
    dispatches,
    coverage_status: gaps.some(gap => (typeof gap?.name === "string" && gap.name.startsWith("reviewer-window-") && gap.name !== "reviewer-window-coverage-unknown") || gap?.name === "usage-manifest-missing")
      ? "partial"
      : (gaps.some(gap => gap?.name === "reviewer-window-coverage-unknown") ? "unknown" : "complete"),
    arithmeticTotals,
    deduped_sessions: dedupedSessions,
    lineage_attribution: {
      dispatch_rows: uniqueManifests.length,
      external_reviewer_sessions: uniqueSessionUsage.filter((entry) => entry.role === "reviewer").length,
      unique_sessions: uniqueSessionUsage,
    },
    cost_usd: costUsdCount > 0 ? costUsdSum : null,
    cost_usd_note: costUsdCount > 0
      ? `sum of ${costUsdCount} unique session(s) with cost_usd; 非 host 對帳`
      : "N/A: no sessions with cost_usd",
    gaps,
  };
}

/**
 * Render markdown for Recap Token 回顧 from manifest rollup.
 */
export function renderManifestRollupMarkdown(rollup, {
  top = 20,
  sort = "output",
  itemWidth = 80,
  homeDir,
} = {}) {
  const lines = [];
  lines.push("### Dispatch 關聯用量（usage-manifest 自動彙總）");
  lines.push("");
  for (const dispatch of rollup.dispatches) {
    const { manifest } = dispatch;
    lines.push(
      `#### ${manifest.dispatch_id} · ${manifest.mode} · target=${manifest.review_target} · head=${String(manifest.head_ref_oid ?? "").slice(0, 12)}`,
    );
    lines.push("");
    for (const { manifestSession, usage } of dispatch.sessions) {
      lines.push(`##### ${manifestSession.role} · ${manifestSession.host} · ${manifestSession.session_id}`);
      lines.push("");
      if (!usage.available) {
        lines.push(`- source: N/A: ${usage.reason}`);
        lines.push("");
        continue;
      }
      if (manifestSession.role === "reviewer" && manifestSession.host === "codex") {
        lines.push(`- source: ${usage.reviewer_source ?? usage.source ?? "transcript"}`);
      }
      lines.push(renderMarkdownLedger(usage, { top, sort, itemWidth, homeDir }));
      lines.push("");
    }
  }
  const totals = rollup.arithmeticTotals;
  lines.push("### 算術彙總（非 host 對帳）");
  lines.push("");
  lines.push(`- paged coverage: ${rollup.coverage_status}`);
  lines.push(
    `- totals: input ${formatRollupTotalValue(totals.input)} / output ${formatRollupTotalValue(totals.output)} / cache_read ${formatRollupTotalValue(totals.cache_read)} / cache_creation ${formatRollupTotalValue(totals.cache_creation)}`,
  );
  lines.push(
    `- cost_usd: ${rollup.cost_usd === null ? rollup.cost_usd_note : `$${formatDisplayNumber(rollup.cost_usd, { maximumFractionDigits: 4 })}`} (${rollup.cost_usd_note})`,
  );
  lines.push(
    `- gaps: ${rollup.gaps.length === 0 ? "無" : rollup.gaps.map((g) => (
      g.dispatch_id ? `${g.name}(${g.dispatch_id})` : g.name
    )).join(", ")}`,
  );
  lines.push("");
  return lines.join("\n");
}

export function parseDispatchIdList(argvValue) {
  if (!argvValue) return [];
  return argvValue.split(",").map((part) => part.trim()).filter(Boolean);
}
