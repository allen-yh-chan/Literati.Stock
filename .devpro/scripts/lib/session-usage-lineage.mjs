import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

import { CHANGE_ID_SHAPE, UUID_V4_SHAPE, readNoFollowFile } from "./durable-fs.mjs";
import { resolveAdmissionChangeDir, resolveExactOneChangeWorktreeBinding } from "../hooks/lib/admission-record.mjs";
import { classifySessionUsageGap } from "./session-usage-gap-classification.mjs";

export const LINEAGE_REPORT_SCHEMA = "devpro-lineage-usage-report/v1";
export const EVIDENCE_BOUNDARY_SCHEMA = "devpro-lineage-evidence-boundary/v1";

export const DEFAULT_LINEAGE_LIMITS = Object.freeze({
  max_files: 10_000,
  max_meta_record_bytes: 65_536,
  max_total_meta_bytes: 67_108_864,
  max_nodes: 2_048,
  max_depth: 64,
});

const METRIC_KEYS = ["input", "output", "cache_read", "cache_creation", "cost_usd"];
const BOUNDARY_HOSTS = new Set(["codex", "claude-code"]);
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function state(stateName, reason) {
  return { state: stateName, reason };
}

function numberState(value) {
  return { state: "number", value };
}

function normalizeMetric(value, fallbackReason = "metric-unavailable") {
  if (isFiniteNumber(value)) return numberState(value);
  if (isPlainObject(value) && value.state === "number" && isFiniteNumber(value.value)) return numberState(value.value);
  if (isPlainObject(value) && ["unavailable", "not-applicable", "unverified"].includes(value.state)) {
    return state(value.state, String(value.reason || fallbackReason));
  }
  return state("unavailable", fallbackReason);
}

function sumMetricStates(values) {
  const normalized = values.map((value) => normalizeMetric(value));
  if (normalized.length === 0) return numberState(0);
  const nonNumeric = normalized.filter((value) => value.state !== "number");
  if (nonNumeric.length === 0) {
    return numberState(normalized.reduce((sum, value) => sum + value.value, 0));
  }
  const unavailable = nonNumeric.find((value) => value.state === "unavailable" || value.state === "unverified");
  if (unavailable) return state("unavailable", unavailable.reason);
  return state("not-applicable", nonNumeric[0].reason);
}

function valueOrState(metricState) {
  return metricState.state === "number" ? metricState.value : metricState;
}

function metricFromContributor(contributor, key) {
  if (key === "cost_usd") return contributor.cost_usd;
  return contributor[key];
}

/** Reconcile each metric without manufacturing zero for unsupported values. */
export function reconcileLineageMetrics({
  root = [],
  descendants = [],
  externalReviewers = [],
  reported = {},
} = {}) {
  const result = {};
  const gaps = [];
  for (const key of METRIC_KEYS) {
    const rootState = sumMetricStates(root.map((item) => metricFromContributor(item, key)));
    const descendantState = sumMetricStates(descendants.map((item) => metricFromContributor(item, key)));
    const externalState = sumMetricStates(externalReviewers.map((item) => metricFromContributor(item, key)));
    const inclusiveState = sumMetricStates([rootState, descendantState, externalState]);
    const reportedValue = reported?.[key];
    let status = inclusiveState.state === "number" ? "reconciled" : "unavailable";
    let delta = null;
    if (reportedValue !== undefined && inclusiveState.state === "number") {
      const reportedState = normalizeMetric(reportedValue, "reported-metric-unavailable");
      if (reportedState.state !== "number") {
        status = "unavailable";
      } else {
        delta = inclusiveState.value - reportedState.value;
        if (delta !== 0) {
          status = "mismatch";
          gaps.push({ name: "lineage-metric-mismatch", metric: key, delta });
        }
      }
    }
    result[key] = {
      root: valueOrState(rootState),
      descendants: valueOrState(descendantState),
      external_reviewers: valueOrState(externalState),
      lineage_inclusive: valueOrState(inclusiveState),
      status,
      delta,
    };
  }
  result.gaps = gaps;
  return result;
}

export function canonicalSessionIdentity(value) {
  const host = String(value?.host ?? "").trim();
  const sessionId = String(value?.session_id ?? value?.session ?? "").trim();
  if (!host || !sessionId || host.includes(":") || /[\r\n]/u.test(sessionId)) return null;
  return `${host}:${sessionId}`;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableObject(value));
}

export function digestEvidenceBoundary(value) {
  const clone = { ...value };
  delete clone.boundary_digest;
  delete clone.source;
  delete clone.computed_digest;
  return createHash("sha256").update(stableJson(clone)).digest("hex");
}

function assertUtcZ(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`invalid evidence boundary ${field}`);
  }
}

function assertBoundarySession(entry, field) {
  if (
    !isPlainObject(entry) ||
    !BOUNDARY_HOSTS.has(entry.host) ||
    !UUID_SHAPE.test(entry.session_id ?? "") ||
    !canonicalSessionIdentity(entry)
  ) {
    throw new Error(`invalid evidence boundary ${field}`);
  }
}

function assertExpectedTree(value, field = "expected") {
  if (!isPlainObject(value)) throw new Error(`invalid evidence boundary ${field}`);
  for (const [key, item] of Object.entries(value)) {
    if (field === "expected" && key === "identity_digest_sha256") {
      if (typeof item !== "string" || !/^[0-9a-f]{64}$/u.test(item)) {
        throw new Error(`invalid evidence boundary ${field}.${key}`);
      }
      continue;
    }
    if (isPlainObject(item)) assertExpectedTree(item, `${field}.${key}`);
    else if (!safeInteger(item)) throw new Error(`invalid evidence boundary ${field}.${key}`);
  }
}

/** Strict v1 parser. Expected values are assertions only and never contributors. */
export function parseEvidenceBoundary(value, { sourceName } = {}) {
  if (!isPlainObject(value) || value.schema !== EVIDENCE_BOUNDARY_SCHEMA) {
    throw new Error("unsupported evidence boundary schema");
  }
  if (!["current-change", "mixed-session", "session-wide"].includes(value.scope)) {
    throw new Error("invalid evidence boundary scope");
  }
  if (!Array.isArray(value.roots) || value.roots.length === 0) throw new Error("evidence boundary requires roots");
  value.roots.forEach((entry) => assertBoundarySession(entry, "root"));
  if (!Array.isArray(value.external_sessions ?? [])) throw new Error("invalid evidence boundary external_sessions");
  (value.external_sessions ?? []).forEach((entry) => assertBoundarySession(entry, "external_session"));
  assertUtcZ(value.generated_at, "generated_at");
  assertUtcZ(value.observed_through, "observed_through");
  assertUtcZ(value.closed_at, "closed_at");
  if (Date.parse(value.closed_at) < Date.parse(value.observed_through)) {
    throw new Error("evidence boundary closed_at precedes observed_through");
  }
  if (typeof value.terminality_evidence !== "string" || !value.terminality_evidence.trim()) {
    throw new Error("invalid evidence boundary terminality_evidence");
  }
  if (/[\\/]/u.test(value.terminality_evidence) || value.terminality_evidence.includes("..")) {
    throw new Error("unsafe evidence boundary terminality_evidence");
  }
  assertExpectedTree(value.expected);
  if (typeof value.expected.identity_digest_sha256 !== "string") {
    throw new Error("evidence boundary requires expected.identity_digest_sha256");
  }
  if (typeof value.boundary_digest !== "string" || !/^[0-9a-f]{64}$/u.test(value.boundary_digest)) {
    throw new Error("evidence boundary requires boundary_digest");
  }
  const digest = digestEvidenceBoundary(value);
  return {
    ...value,
    external_sessions: value.external_sessions ?? [],
    boundary_digest: value.boundary_digest,
    computed_digest: digest,
    source: sourceName ? path.basename(sourceName) : undefined,
  };
}

/** Claude context classification follows the evidence trust ladder in D4. */
export function probeClaudeContextMode(evidence = {}) {
  const trusted = evidence.trusted_mode;
  if (["fresh", "fork", "resume", "nested"].includes(trusted)) {
    return { mode: trusted, gaps: [] };
  }
  // T10: host meta carrier (`agent-<id>.meta.json`: agentType + spawnDepth,
  // observed on Claude Code 2.1.25x). agentType mirrors the Agent tool's
  // `subagent_type` (named dp-* projections observed; `fork` follows the same
  // carrier). Depth ≥ 2 is a nested spawn. Continuation (SendMessage) is a
  // property of later dispatch turns on the same node, not a spawn class —
  // see deriveDelegationTelemetry; `tool_input.resume` below is legacy only.
  if (Number.isInteger(evidence.spawn_depth) && evidence.spawn_depth >= 1) {
    if (evidence.spawn_depth >= 2) return { mode: "nested", gaps: [] };
    if (evidence.agent_type === "fork") return { mode: "fork", gaps: [] };
    if (typeof evidence.agent_type === "string" && evidence.agent_type) return { mode: "fresh", gaps: [] };
  }
  if (
    typeof evidence.tool_input?.resume === "string" &&
    evidence.tool_input.resume &&
    evidence.tool_input.resume === evidence.session_id
  ) {
    return { mode: "resume", gaps: [] };
  }
  if (evidence.named_fresh === true && evidence.fork_enabled === false) {
    return { mode: "fresh", gaps: [] };
  }
  if (evidence.nested_call === true) {
    if (typeof evidence.nested_carrier === "string" && evidence.nested_carrier) {
      return { mode: "nested", gaps: [] };
    }
    return { mode: "unknown", gaps: [{ name: "claude-nested-lineage-unresolved" }] };
  }
  return { mode: "unknown", gaps: [{ name: "claude-context-mode-unknown" }] };
}

export function probeClaudeLineageMetadata(input = {}) {
  const parentIdentity = canonicalSessionIdentity(input.parent);
  const nodes = [];
  const edges = [];
  const gaps = [];
  const diagnostics = [];
  const seenHistory = new Set();
  for (const relationship of input.relationships ?? []) {
    const probe = probeClaudeContextMode(relationship);
    if (probe.mode === "unknown") {
      gaps.push(...probe.gaps);
      continue;
    }
    const child = {
      host: "claude-code",
      session_id: relationship.session_id,
      context_mode: probe.mode,
      delegation_evidence: delegationEvidenceOf(relationship),
    };
    const childIdentity = canonicalSessionIdentity(child);
    if (!parentIdentity || !childIdentity) {
      gaps.push({ name: "claude-lineage-identity-unresolved" });
      continue;
    }
    const historyKey = `${childIdentity}:${relationship.terminal_message_id ?? "no-terminal-message"}`;
    if (probe.mode === "resume" && seenHistory.has(historyKey)) {
      diagnostics.push({ name: "claude-resume-history-deduped" });
      continue;
    }
    seenHistory.add(historyKey);
    nodes.push(child);
    edges.push({
      parent_identity: parentIdentity,
      child_identity: childIdentity,
      evidence_digest: createHash("sha256").update(stableJson({ child: childIdentity, mode: probe.mode, terminal: relationship.terminal_message_id ?? null })).digest("hex"),
    });
  }
  return {
    nodes,
    edges,
    gaps,
    diagnostics,
    spawn_events: (input.relationships ?? []).length,
    spawn_observability: gaps.length === 0 ? "complete" : "partial",
  };
}

const DELEGATION_EVIDENCE_KEYS = ["agent_type", "spawn_depth", "dispatch_turns", "prompt_sha256", "start_ts", "end_ts"];

function delegationEvidenceOf(relationship) {
  if (!DELEGATION_EVIDENCE_KEYS.some((key) => relationship?.[key] !== undefined)) return null;
  return Object.fromEntries(DELEGATION_EVIDENCE_KEYS.map((key) => [key, relationship[key] ?? null]));
}

/**
 * T29 (strengthen-subagent-delegation-strategy): delegation evidence for a
 * Codex child thread, derived only from carriers proven by the committed
 * redacted fixture `codex-continuation-followup-task.json` (codex-cli 0.152.1):
 *  - `spawnCarrier`   child `session_meta.payload.source.subagent.thread_spawn`
 *                     (`depth`, `agent_role`, `agent_path`)
 *  - `activity`       the child's own parsed rollout (`turn_boundaries`)
 *  - `parentActivity` the parent's parsed rollout (`spawn_dispatches`), joined
 *                     to the child through `agent_path`
 * Continuation is a later `task_started` boundary on the same thread (the
 * parent's `followup_task` call). Missing boundaries stay `null` and name
 * `codex-continuation-unverified`; an unjoinable dispatch leaves the context
 * mode `null` (policy_mode `unknown`) and names `codex-context-mode-unknown`.
 * Nothing here infers a tool name, a default fork mode, or a zero.
 */
export function deriveCodexDescendantEvidence({ spawnCarrier, activity, parentActivity } = {}) {
  const carrier = isPlainObject(spawnCarrier) ? spawnCarrier : {};
  const depth = Number.isInteger(carrier.depth) ? carrier.depth : null;
  const agentPath = typeof carrier.agent_path === "string" && carrier.agent_path ? carrier.agent_path : null;
  const dispatches = Array.isArray(parentActivity?.spawn_dispatches) ? parentActivity.spawn_dispatches : [];
  const matches = agentPath === null ? [] : dispatches.filter((item) => isPlainObject(item) && item.agent_path === agentPath);
  const dispatch = matches.length === 1 ? matches[0] : null;
  let contextMode = null;
  if (depth !== null && depth >= 2) contextMode = "nested";
  else if (dispatch) {
    if (dispatch.fork_turns === "none" || dispatch.fork_context === false) contextMode = "fresh";
    else if ((typeof dispatch.fork_turns === "string" && /^(?:all|[1-9][0-9]*)$/u.test(dispatch.fork_turns)) || dispatch.fork_context === true) contextMode = "fork";
  }
  const boundaries = isPlainObject(activity?.turn_boundaries) ? activity.turn_boundaries : null;
  const dispatchTurns = Number.isInteger(boundaries?.dispatch_turns) && boundaries.dispatch_turns > 0 ? boundaries.dispatch_turns : null;
  const agentRole = typeof carrier.agent_role === "string" && carrier.agent_role ? carrier.agent_role : null;
  const evidence = {
    agent_type: agentRole ?? (typeof dispatch?.agent_type === "string" && dispatch.agent_type ? dispatch.agent_type : null),
    spawn_depth: depth,
    dispatch_turns: dispatchTurns,
    prompt_sha256: null,
    start_ts: typeof boundaries?.start_ts === "string" ? boundaries.start_ts : null,
    end_ts: typeof boundaries?.end_ts === "string" ? boundaries.end_ts : null,
  };
  const gaps = [];
  if (dispatchTurns === null) gaps.push({ name: "codex-continuation-unverified" });
  if (contextMode === null) gaps.push({ name: "codex-context-mode-unknown" });
  return { context_mode: contextMode, delegation_evidence: evidence, gaps };
}

function normalizeEdge(edge) {
  const parentIdentity = edge?.parent_identity ?? canonicalSessionIdentity(edge?.parent);
  const childIdentity = edge?.child_identity ?? canonicalSessionIdentity(edge?.child);
  return {
    parent_identity: parentIdentity,
    child_identity: childIdentity,
    evidence_digest: String(edge?.evidence_digest ?? "unverified"),
  };
}

function collisionFingerprint(node) {
  if (node?.carrier_digest) return `carrier:${node.carrier_digest}`;
  if (node?.usage) return `usage:${stableJson(node.usage)}`;
  return null;
}

function addNode(nodeByIdentity, node, gaps) {
  const identity = canonicalSessionIdentity(node);
  if (!identity) {
    gaps.push({ name: "lineage-edge-unresolved", identity: "invalid-session-identity" });
    return null;
  }
  const existing = nodeByIdentity.get(identity);
  if (!existing) {
    nodeByIdentity.set(identity, { ...node, identity });
    return identity;
  }
  const left = collisionFingerprint(existing);
  const right = collisionFingerprint(node);
  if (left && right && left !== right) {
    gaps.push({ name: "lineage-identity-collision", identity });
    existing.collision = true;
  }
  if (!existing.usage && node.usage) existing.usage = node.usage;
  if (!existing.terminality && node.terminality) existing.terminality = node.terminality;
  return identity;
}

function usageMetricState(usage, key) {
  const value = key === "cost_usd" ? usage?.cost_usd : usage?.totals?.[key];
  if (isFiniteNumber(value)) return value;
  const availability = usage?.field_availability?.[key];
  if (availability === "unsupported-by-host" || availability === "not-applicable") {
    return state("not-applicable", availability);
  }
  return state("unavailable", availability || usage?.reason || "metric-unavailable");
}

function normalizedContributor(node, role, adapter, gaps) {
  let usage;
  const snapshot = node.usage_snapshot;
  const snapshotUsage = node.usage?.available
    && node.usage.reviewer_source === "reviewer-manifest:turn.completed.usage"
    ? node.usage
    : snapshot?.source === "reviewer-manifest:turn.completed.usage" && isPlainObject(snapshot.totals)
      ? {
          available: true,
          totals: snapshot.totals,
          source: snapshot.source,
          reviewer_source: snapshot.source,
          field_availability: {
            input: "available",
            output: "available",
            cache_read: "available",
            cache_creation: "unsupported-by-host",
            cost_usd: "unsupported-by-host",
          },
          cost_usd: null,
        }
      : null;
  try {
    const adapterUsage = adapter?.readSessionUsage
      ? adapter.readSessionUsage({ host: node.host, session_id: node.session_id ?? node.session, metadata: node })
      : null;
    usage = adapterUsage?.available
      ? adapterUsage
      : snapshotUsage
        ? snapshotUsage
        : !adapter?.readSessionUsage && node.usage
        ? {
            available: true,
            totals: node.usage,
            cost_usd: node.cost_usd ?? null,
            field_availability: node.field_availability ?? {},
            terminality: node.terminality,
          }
        : adapterUsage ?? { available: false, reason: "host-adapter-unavailable" };
  } catch {
    usage = snapshotUsage ?? { available: false, reason: "session-usage-read-failed" };
  }
  if (!usage?.available) {
    gaps.push({ name: "session-usage-unavailable", identity: node.identity });
  }
  // #2627 / D1: unconvertible collapsed deduped MUST block lineage-complete.
  const usageGapEffects = [];
  for (const gap of Array.isArray(usage?.gaps) ? usage.gaps : []) {
    if (node.host === "codex" && typeof gap?.name === "string") {
      const axisEffects = classifySessionUsageGap(gap, { domain: "codex-metering" });
      const identifiedGap = { ...gap, identity: node.identity, axis_effects: axisEffects };
      gaps.push(identifiedGap);
      usageGapEffects.push({ name: gap.name, ...axisEffects });
    } else if (gap?.name === "collapsed-deduped-unconvertible") {
      const axisEffects = classifySessionUsageGap(gap, { domain: "lineage" });
      gaps.push({ name: "collapsed-deduped-unconvertible", identity: node.identity, axis_effects: axisEffects });
      usageGapEffects.push({ name: gap.name, ...axisEffects });
    }
  }
  const metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, usageMetricState(usage, key)]));
  return {
    identity: node.identity,
    host: node.host,
    session_id: node.session_id ?? node.session,
    role,
    terminality: usage?.terminality ?? node.terminality ?? "unknown",
    context_mode: node.context_mode,
    ...metrics,
    usage_source: usage?.usage_source ?? null,
    usage_segments: usage?.usage_segments ?? [],
    usage_segment_scope: usage?.usage_segment_scope ?? "session-wide",
    usage_reconciliation: usage?.usage_reconciliation ?? { status: "unverified" },
    usage_reconciliation_scope: usage?.usage_reconciliation_scope ?? "session-wide",
    usage_attribution: usage?.usage_attribution ?? { status: "not-reported" },
    usage_attribution_scope: usage?.usage_attribution_scope ?? "session-wide",
    usage_gap_effects: usageGapEffects,
    ...(role === "external-reviewer" && node.host === "codex"
      ? { reviewer_source: usage?.reviewer_source ?? (usage?.available ? "transcript" : null) }
      : {}),
  };
}

function observedTokens(contributors) {
  const values = contributors.map((item) => {
    const input = normalizeMetric(item.input);
    const output = normalizeMetric(item.output);
    if (input.state !== "number" || output.state !== "number") return state("unavailable", "input-or-output-unavailable");
    return input.value + output.value;
  });
  return sumMetricStates(values);
}

export function digestContributorIdentities(contributors = []) {
  const identities = contributors
    .map((contributor) => `${contributor.role}\u0000${contributor.identity}`)
    .sort();
  return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

function expectedMetricActual(report, key) {
  const observed = report.metrics.observed_tokens;
  const map = {
    root_observed_tokens: observed.root,
    descendant_observed_tokens: observed.descendants,
    external_reviewer_observed_tokens: observed.external_reviewers,
    lineage_observed_tokens: observed.lineage_inclusive,
  };
  if (Object.hasOwn(map, key)) return map[key];
  const match = /^(root|descendant|external_reviewer|lineage)_(input|output|cache_read|cache_creation)$/u.exec(key);
  if (!match) return undefined;
  const roleMap = { root: "root", descendant: "descendants", external_reviewer: "external_reviewers", lineage: "lineage_inclusive" };
  return report.metrics[match[2]]?.[roleMap[match[1]]];
}

function applyBoundaryAssertions(report, boundary) {
  if (boundary?.schema !== EVIDENCE_BOUNDARY_SCHEMA) return;
  const differences = [];
  for (const [key, expected] of Object.entries(boundary.expected?.counts ?? {})) {
    const actual = report.counts[key];
    if (actual !== expected) differences.push({ field: `counts.${key}`, expected, actual });
  }
  for (const [key, expected] of Object.entries(boundary.expected?.metrics ?? {})) {
    const actual = expectedMetricActual(report, key);
    if (actual !== expected) differences.push({ field: `metrics.${key}`, expected, actual });
  }
  if (boundary.expected?.identity_digest_sha256) {
    const actual = digestContributorIdentities(report.contributors);
    if (actual !== boundary.expected.identity_digest_sha256) {
      differences.push({ field: "identity_digest_sha256", expected: boundary.expected.identity_digest_sha256, actual });
    }
  }
  if (boundary.boundary_digest !== boundary.computed_digest) {
    differences.push({ field: "boundary_digest", expected: boundary.boundary_digest, actual: boundary.computed_digest });
  }
  if (differences.length > 0) {
    report.evidence_status = "drift";
    report.gaps.push({ name: "evidence-boundary-drift", mismatch_count: differences.length, differences });
    report.claim.claims = report.claim.claims.filter((claim) => claim !== "reproduced");
  } else {
    report.evidence_status = "reproduced";
  }
}

/** Build a deterministic, bounded session graph and reconcile unique contributors. */
export const REPLACEMENT_REASONS = Object.freeze(["context-growth", "independence", "rule-leaf-changed", "identity-lost", "terminal", "concurrency-slot"]);
const REVIEW_LANE_ROLES = new Set(["dp-second-reviewer"]);
const SHA256_SHAPE = /^[0-9a-f]{64}$/u;
const ADMISSION_RECORD_LIMIT = 500;

function laneOfRole(role) {
  if (typeof role !== "string" || !role) return "unknown";
  return REVIEW_LANE_ROLES.has(role) ? "review" : "work";
}

function parseTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * T10 (strengthen-subagent-delegation-strategy D13): the eight lineage-owned
 * delegation fields. Every value is derived from evidence handed in
 * (descendant nodes' `delegation_evidence`, admission records matched by
 * `prompt_sha256`); missing evidence yields `"unknown"` (or `null` for "no
 * replacement"), never 0. `0` is emitted only as positive evidence: a
 * complete zero-spawn observation, or an available-and-empty record set with
 * no observed descendants.
 */
export function deriveDelegationTelemetry({ descendants = [], externals = [], admissionRecords = {}, spawnObservable = false } = {}) {
  const gaps = [];
  const recordsAvailable = admissionRecords?.available === true && Array.isArray(admissionRecords.records);
  const records = recordsAvailable ? admissionRecords.records.filter(isPlainObject) : [];
  if (!recordsAvailable) gaps.push({ name: "admission-records-unavailable", reason: admissionRecords?.reason ?? "not-provided" });
  // I-07 (PR #2473 second cross-model round): `readChangeAdmissionRecords`
  // returns `truncated: true` once the directory exceeds ADMISSION_RECORD_LIMIT,
  // and nothing read it. A corpus cut to the first N therefore fed
  // `work_lane_fresh_total` and the policy-mode counts as if it were complete —
  // BRD S2 requires missing evidence to surface as a named gap, never to be
  // silently counted as all there is.
  if (recordsAvailable && admissionRecords.truncated === true) {
    gaps.push({ name: "admission-records-truncated", limit: ADMISSION_RECORD_LIMIT });
  }
  if (recordsAvailable && Number.isInteger(admissionRecords.malformed) && admissionRecords.malformed > 0) {
    gaps.push({ name: "admission-records-malformed", count: admissionRecords.malformed });
  }
  const recordByPrompt = new Map();
  for (const record of records) {
    if (typeof record.prompt_sha256 === "string" && SHA256_SHAPE.test(record.prompt_sha256)) recordByPrompt.set(record.prompt_sha256, record);
  }
  // Design D6 (2.1a) + decisions D30: `role_binding` already encodes whether the
  // host-carried Codex `agent_type` corroborated the role (closed-set dp-* name →
  // host-verified). Only a cooperative-only binding means the carrier was not
  // verified (custom agent name / opaque message), so it is surfaced as a named
  // gap, never as parity.
  const codexDeclaredRoles = records.filter((record) => typeof record.host === "string" && record.host.startsWith("codex") && record.role_binding === "cooperative-only");
  if (codexDeclaredRoles.length > 0) gaps.push({ name: "codex-role-carrier-unverified", records: codexDeclaredRoles.length });
  // D34: `instance_mode: continue` records (SendMessage / followup_task
  // continuations) participate only through the record set — they carry the
  // responsibility thread and its receipt chain, and MUST NOT be counted as
  // fresh work-lane spawns. `work_lane_fresh_total` below filters on `fresh`
  // for exactly that reason, and continuation volume stays reported through
  // transcript-observed `continuation_turns` rather than inferred from records.
  const freshRecordsByResponsibility = new Map();
  for (const record of records) {
    if (record.instance_mode !== "fresh" || typeof record.responsibility_id !== "string") continue;
    const list = freshRecordsByResponsibility.get(record.responsibility_id) ?? [];
    list.push(record);
    freshRecordsByResponsibility.set(record.responsibility_id, list);
  }

  const perContributor = [];
  for (const node of descendants) {
    // T29: host-derived evidence gaps (e.g. `codex-continuation-unverified`)
    // travel with the node and surface here, keyed by contributor identity.
    for (const gap of Array.isArray(node.delegation_gaps) ? node.delegation_gaps : []) {
      if (typeof gap?.name === "string" && gap.name) gaps.push({ name: gap.name, identity: node.identity });
    }
    const evidence = isPlainObject(node.delegation_evidence) ? node.delegation_evidence : null;
    const mode = node.context_mode;
    const policyMode = mode === "fresh" || mode === "nested" ? "fresh" : mode === "fork" ? "fork" : mode === "resume" ? "continue" : "unknown";
    if (policyMode === "unknown") gaps.push({ name: "policy-mode-unknown", identity: node.identity });
    const record = evidence?.prompt_sha256 ? recordByPrompt.get(evidence.prompt_sha256) ?? null : null;
    const responsibilityId = typeof record?.responsibility_id === "string" ? record.responsibility_id : "unknown";
    const lane = record ? laneOfRole(record.role) : laneOfRole(evidence?.agent_type);
    let replacementReason = "unknown";
    if (record) {
      if (REPLACEMENT_REASONS.includes(record.replacement_reason)) replacementReason = record.replacement_reason;
      else {
        const recordTime = parseTimestamp(record.admitted_at);
        const earlierFresh = (freshRecordsByResponsibility.get(responsibilityId) ?? []).some((other) => other !== record && parseTimestamp(other.admitted_at) !== null && recordTime !== null && parseTimestamp(other.admitted_at) < recordTime);
        replacementReason = earlierFresh ? "unknown" : null;
      }
    }
    const dispatchTurns = Number.isInteger(evidence?.dispatch_turns) ? evidence.dispatch_turns : null;
    const continuationTurns = dispatchTurns === null ? null : Math.max(dispatchTurns - 1, 0);
    perContributor.push({
      identity: node.identity,
      role: "descendant",
      policy_mode: policyMode,
      lane,
      responsibility_id: responsibilityId,
      replacement_reason: replacementReason,
      continuation_turns: continuationTurns,
      agent_type: typeof evidence?.agent_type === "string" ? evidence.agent_type : null,
      spawn_depth: Number.isInteger(evidence?.spawn_depth) ? evidence.spawn_depth : null,
      admission_record_id: typeof record?.record_id === "string" ? record.record_id : null,
    });
  }
  for (const node of externals) {
    perContributor.push({
      identity: node.identity,
      role: "external-reviewer",
      policy_mode: "external",
      lane: "review",
      responsibility_id: "unknown",
      replacement_reason: null,
      continuation_turns: null,
      agent_type: null,
      spawn_depth: null,
      admission_record_id: null,
    });
  }

  const descendantRows = perContributor.filter((row) => row.role === "descendant");
  const counts = { fresh: 0, continue: 0, fork: 0, external: externals.length, unknown: 0 };
  for (const row of descendantRows) {
    counts[row.policy_mode] += 1;
    if (row.continuation_turns !== null) counts.continue += row.continuation_turns;
  }

  let workLaneFreshTotal = "unknown";
  if (recordsAvailable) {
    const freshWork = records.filter((record) => record.instance_mode === "fresh" && laneOfRole(record.role) === "work").length;
    if (freshWork > 0) workLaneFreshTotal = freshWork;
    else if (descendantRows.length === 0 && spawnObservable) workLaneFreshTotal = 0;
    else gaps.push({ name: "admission-records-incomplete", observed_descendants: descendantRows.length });
  }

  let peak = "unknown";
  if (descendantRows.length === 0) {
    if (spawnObservable) peak = 0;
  } else {
    const intervals = descendants.map((node) => [parseTimestamp(node.delegation_evidence?.start_ts), parseTimestamp(node.delegation_evidence?.end_ts)]);
    if (intervals.every(([start, end]) => start !== null && end !== null && end >= start)) {
      // I-08 (PR #2473 second cross-model round): these are CLOSED intervals, so
      // at an equal timestamp a start must be applied before an end. Sorting
      // `-1` first (a[1] - b[1]) made a child with a single assistant output —
      // start === end — decrement before it ever incremented, leaving
      // `peak_runtime_native_concurrency: 0` while child evidence plainly existed.
      // Reporting 0 from present evidence is the inference BRD S2 forbids.
      const events = intervals.flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      let active = 0;
      let max = 0;
      for (const [, delta] of events) {
        active += delta;
        if (active > max) max = active;
      }
      peak = max;
    }
  }

  let childRoundTrips = "unknown";
  if (descendantRows.length === 0) {
    if (spawnObservable) childRoundTrips = 0;
  } else if (descendantRows.every((row) => row.continuation_turns !== null)) {
    childRoundTrips = descendantRows.reduce((sum, row) => sum + row.continuation_turns + 1, 0);
  }

  let continueRatio = "unknown";
  const ratioMeasurable = descendantRows.length > 0 && descendantRows.every((row) => row.policy_mode !== "unknown" && row.continuation_turns !== null);
  if (ratioMeasurable) {
    const spawns = counts.fresh + counts.fork;
    const denominator = spawns + counts.continue;
    if (denominator > 0) continueRatio = Math.round((counts.continue / denominator) * 1000) / 1000;
  }

  return {
    per_contributor: perContributor,
    policy_mode_counts: counts,
    work_lane_fresh_total: workLaneFreshTotal,
    peak_runtime_native_concurrency: peak,
    child_round_trips: childRoundTrips,
    continue_ratio: continueRatio,
    gaps,
  };
}

/**
 * Closed reason-token set of `loadAdmissionRecords` (strengthen-admission-
 * binding-portability T8): every unavailable verdict carries one of these
 * stable tokens, never a free-form string. `binding-unresolved` is the new
 * member: the exact-one binding could not be resolved AND the historical
 * caller-root fallback (the worktree-removed / archived window) located no
 * change directory either.
 */
export const ADMISSION_RECORDS_REASONS = Object.freeze([
  "change-id-invalid",
  "repo-root-missing",
  "admission-records-dir-missing",
  "admission-records-dir-unreadable",
  "binding-unresolved",
]);

/**
 * Reads `openspec/changes/<change_id>/admission-records/*.json` (written by
 * the spawn admission hook) as evidence for deriveDelegationTelemetry. Read
 * only; bounded; no prompt text exists in the records by contract.
 *
 * Binding root first (design D7.7): the spawn gate now writes records under
 * the same-common-dir exact-one `.worktree/<change_id>` binding worktree, so a
 * telemetry read from the main checkout MUST look there before the caller
 * root. Resolution failure keeps the historical caller-root read — the
 * worktree-removed / `openspec archive` window stays readable — and reports
 * the closed token `binding-unresolved` when that fallback finds nothing.
 */
export function loadAdmissionRecords({ repoRoot, changeName } = {}) {
  if (typeof changeName !== "string" || !CHANGE_ID_SHAPE.test(changeName)) return { available: false, reason: "change-id-invalid" };
  if (typeof repoRoot !== "string" || !repoRoot) return { available: false, reason: "repo-root-missing" };
  const binding = resolveExactOneChangeWorktreeBinding({ cwd: repoRoot, changeId: changeName, requireChangeDir: false });
  const changeDir = binding.ok
    ? (binding.changeDir ?? resolveAdmissionChangeDir(repoRoot, changeName))
    : resolveAdmissionChangeDir(repoRoot, changeName);
  if (changeDir === null) return { available: false, reason: binding.ok ? "admission-records-dir-missing" : "binding-unresolved" };
  const dir = path.join(changeDir, "admission-records");
  let entries;
  try {
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return { available: false, reason: "admission-records-dir-missing" };
    entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { available: false, reason: "admission-records-dir-unreadable" };
  }
  const records = [];
  let malformed = 0;
  for (const name of entries.slice(0, ADMISSION_RECORD_LIMIT)) {
    try {
      if (!UUID_V4_SHAPE.test(name.slice(0, -".json".length))) {
        malformed += 1;
        continue;
      }
      // D15 (C) Read: no-follow + same-inode + containment, body via the fd.
      const { bytes } = readNoFollowFile({ root: changeDir, parent: dir, target: path.join(dir, name), maxBytes: 64 * 1024 });
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (!isPlainObject(parsed)) {
        malformed += 1;
        continue;
      }
      records.push(parsed);
    } catch {
      malformed += 1;
    }
  }
  return { available: true, records, malformed, truncated: entries.length > ADMISSION_RECORD_LIMIT };
}

export function buildLineageUsageReport({
  roots = [],
  externalSessions = [],
  boundary = {},
  hostAdapters = {},
  limits: limitOverrides = {},
  admissionRecords = { available: false, reason: "not-provided" },
  now = () => new Date().toISOString(),
} = {}) {
  const limits = { ...DEFAULT_LINEAGE_LIMITS, ...limitOverrides };
  const gaps = [];
  const diagnostics = [];
  const nodeByIdentity = new Map();
  const rootIdentities = new Set();
  const allEdges = [];
  let spawnEvents = 0;
  let spawnObservable = true;

  if (roots.length === 0) {
    spawnObservable = false;
    gaps.push({ name: "lineage-root-unavailable" });
  }

  for (const root of roots) {
    const identity = addNode(nodeByIdentity, root, gaps);
    if (identity) rootIdentities.add(identity);
    const adapter = hostAdapters[root.host];
    if (!adapter?.enumerateMetadata) {
      spawnObservable = false;
      gaps.push({ name: root.host === "codex" ? "codex-spawn-observability-unverified" : "host-lineage-evidence-unavailable", identity });
      continue;
    }
    let enumeration;
    try {
      enumeration = adapter.enumerateMetadata({ root, boundary, limits });
    } catch {
      enumeration = { nodes: [], edges: [], gaps: [{ name: "lineage-metadata-read-failed", identity }], spawn_observability: "unavailable" };
    }
    for (const node of enumeration?.nodes ?? []) addNode(nodeByIdentity, node, gaps);
    allEdges.push(...(enumeration?.edges ?? []).map(normalizeEdge));
    spawnEvents += safeInteger(enumeration?.spawn_events) ? enumeration.spawn_events : 0;
    if (enumeration?.spawn_observability !== "complete") {
      spawnObservable = false;
      gaps.push({ name: root.host === "codex" ? "codex-spawn-observability-unverified" : "host-lineage-evidence-unavailable", identity });
    }
    for (const gap of enumeration?.gaps ?? []) gaps.push({ name: gap.name, ...(gap.identity ? { identity: gap.identity } : {}) });
    for (const item of enumeration?.diagnostics ?? []) diagnostics.push({ name: item.name });
  }

  const edgeKeys = new Set();
  const uniqueEdges = [];
  for (const edge of allEdges) {
    if (!edge.parent_identity || !edge.child_identity) {
      gaps.push({ name: "lineage-edge-unresolved", identity: edge.child_identity ?? "unknown" });
      continue;
    }
    const edgeKey = `${edge.parent_identity}\u0000${edge.child_identity}\u0000${edge.evidence_digest}`;
    if (edgeKeys.has(edgeKey)) {
      diagnostics.push({ name: "lineage-edge-deduped" });
      continue;
    }
    edgeKeys.add(edgeKey);
    uniqueEdges.push(edge);
  }
  uniqueEdges.sort((a, b) => `${a.parent_identity}\u0000${a.child_identity}`.localeCompare(`${b.parent_identity}\u0000${b.child_identity}`));

  const adjacency = new Map();
  const parentSets = new Map();
  for (const edge of uniqueEdges) {
    if (!nodeByIdentity.has(edge.parent_identity) || !nodeByIdentity.has(edge.child_identity)) {
      gaps.push({ name: "lineage-edge-unresolved", identity: edge.child_identity });
      continue;
    }
    const children = adjacency.get(edge.parent_identity) ?? [];
    children.push(edge.child_identity);
    adjacency.set(edge.parent_identity, children);
    const parents = parentSets.get(edge.child_identity) ?? new Set();
    parents.add(edge.parent_identity);
    parentSets.set(edge.child_identity, parents);
  }
  for (const parents of parentSets.values()) {
    if (parents.size > 1) diagnostics.push({ name: "lineage-shared-child-deduped" });
  }
  for (const children of adjacency.values()) children.sort();

  const visited = new Set();
  const queue = [...rootIdentities].sort().map((identity) => ({ identity, depth: 0 }));
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.identity)) continue;
    if (current.depth > limits.max_depth) {
      gaps.push({ name: "lineage-depth-cap-hit", identity: current.identity });
      continue;
    }
    if (visited.size >= limits.max_nodes) {
      gaps.push({ name: "lineage-node-cap-hit", identity: current.identity });
      break;
    }
    visited.add(current.identity);
    for (const child of adjacency.get(current.identity) ?? []) queue.push({ identity: child, depth: current.depth + 1 });
  }

  const color = new Map();
  const visitForCycle = (identity) => {
    color.set(identity, 1);
    for (const child of adjacency.get(identity) ?? []) {
      if (!visited.has(child)) continue;
      if (color.get(child) === 1) {
        if (!gaps.some((gap) => gap.name === "lineage-cycle-detected")) gaps.push({ name: "lineage-cycle-detected", identity: child });
      } else if (!color.has(child)) visitForCycle(child);
    }
    color.set(identity, 2);
  };
  for (const identity of rootIdentities) if (!color.has(identity)) visitForCycle(identity);

  const roleByIdentity = new Map([...visited].map((identity) => [identity, rootIdentities.has(identity) ? "root" : "descendant"]));
  for (const external of externalSessions) {
    const identity = addNode(nodeByIdentity, external, gaps);
    if (!identity) continue;
    const existingRole = roleByIdentity.get(identity);
    if (existingRole === "root" || existingRole === "descendant") {
      gaps.push({ name: "contributor-role-collision", identity });
      continue;
    }
    roleByIdentity.set(identity, "external-reviewer");
  }

  const contributors = [...roleByIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identity, role]) => normalizedContributor(nodeByIdentity.get(identity), role, hostAdapters[nodeByIdentity.get(identity).host], gaps));
  if (boundary.schema === EVIDENCE_BOUNDARY_SCHEMA && boundary.closed_at && boundary.terminality_evidence) {
    for (const contributor of contributors) contributor.terminality = "terminal";
  } else if (["terminal", "open", "unknown"].includes(boundary.terminality)) {
    for (const contributor of contributors) contributor.terminality = boundary.terminality;
  }
  const rootContributors = contributors.filter((item) => item.role === "root");
  const descendantContributors = contributors.filter((item) => item.role === "descendant");
  const externalContributors = contributors.filter((item) => item.role === "external-reviewer");

  const reconciled = reconcileLineageMetrics({
    root: rootContributors,
    descendants: descendantContributors,
    externalReviewers: externalContributors,
    reported: boundary.reported_metrics ?? {},
  });
  gaps.push(...reconciled.gaps);
  delete reconciled.gaps;

  const observedRoot = observedTokens(rootContributors);
  const observedDescendants = observedTokens(descendantContributors);
  const observedExternal = observedTokens(externalContributors);
  const observedInclusive = sumMetricStates([observedRoot, observedDescendants, observedExternal]);
  reconciled.observed_tokens = {
    root: valueOrState(observedRoot),
    descendants: valueOrState(observedDescendants),
    external_reviewers: valueOrState(observedExternal),
    lineage_inclusive: valueOrState(observedInclusive),
    status: observedInclusive.state === "number" ? "reconciled" : "unavailable",
    delta: observedInclusive.state === "number" ? 0 : null,
  };

  const terminalities = contributors.map((item) => item.terminality);
  const terminality = terminalities.includes("open")
    ? "open"
    : terminalities.length > 0 && terminalities.every((item) => item === "terminal")
      ? "terminal"
      : "unknown";
  if (terminality !== "terminal") gaps.push({ name: terminality === "open" ? "lineage-session-open" : "lineage-terminality-unknown" });

  const effectsForGap = (gap) => gap.axis_effects ?? classifySessionUsageGap(gap, { domain: "lineage" });
  const coverageGaps = gaps.filter((gap) => effectsForGap(gap).coverage === "incomplete");
  const coverage = spawnObservable && coverageGaps.length === 0 ? "lineage-complete" : "lineage-incomplete";
  const reconciliationBlockedByGap = gaps.some((gap) => ["gaps", "unavailable"].includes(effectsForGap(gap).reconciliation));
  const reconciliation = rootContributors.length > 0 &&
      !reconciliationBlockedByGap &&
      METRIC_KEYS.every((key) => reconciled[key].status !== "mismatch") &&
      reconciled.input.status === "reconciled" && reconciled.output.status === "reconciled"
    ? "reconciled"
    : "gaps";
  let scope = ["current-change", "mixed-session", "session-wide"].includes(boundary.scope)
    ? boundary.scope
    : "session-wide";
  if (scope === "current-change") {
    const attributed = new Set(Array.isArray(boundary.attributed_session_identities)
      ? boundary.attributed_session_identities.filter((value) => typeof value === "string")
      : []);
    const unattributed = contributors.filter((contributor) => !attributed.has(contributor.identity));
    const attributionGap = gaps.some((gap) => effectsForGap(gap).attribution === "unverified");
    if (boundary.attribution_verified !== true || unattributed.length > 0 || attributionGap) {
      scope = "mixed-session";
      const byRole = new Map();
      for (const contributor of unattributed) byRole.set(contributor.role, (byRole.get(contributor.role) ?? 0) + 1);
      if (byRole.size === 0) gaps.push({ name: "change-attribution-unverified" });
      for (const [role, count] of byRole) {
        gaps.push({ name: `change-attribution-unverified-${role}`, count });
      }
    }
  }
  const lookup = rootContributors.length === 0
    ? "unavailable"
    : roots.every((root) => root.source === "latest-fallback")
      ? "latest-fallback"
      : "exact";
  const claims = [];
  if (scope === "current-change") claims.push("current-change");
  if (coverage === "lineage-complete") claims.push("lineage-complete");
  if (terminality === "terminal") claims.push("final");
  if (reconciliation === "reconciled") claims.push("reconciled");
  if (rootContributors.length === 0) claims.length = 0;

  const delegation = deriveDelegationTelemetry({
    descendants: descendantContributors.map((contributor) => {
      const node = nodeByIdentity.get(contributor.identity) ?? {};
      return {
        identity: contributor.identity,
        context_mode: node.context_mode ?? null,
        delegation_evidence: node.delegation_evidence ?? null,
        delegation_gaps: Array.isArray(node.delegation_gaps) ? node.delegation_gaps : [],
      };
    }),
    externals: externalContributors.map((contributor) => ({ identity: contributor.identity })),
    admissionRecords,
    spawnObservable,
  });

  const report = {
    schema: LINEAGE_REPORT_SCHEMA,
    available: rootContributors.length > 0,
    claim: { lookup, scope, coverage, terminality, reconciliation, claims },
    counts: {
      root_sessions: rootContributors.length,
      descendant_sessions: descendantContributors.length,
      external_reviewer_sessions: externalContributors.length,
      dispatch_rows: externalSessions.length,
      spawn_events: spawnEvents,
    },
    contributors,
    metrics: reconciled,
    delegation,
    gaps,
    diagnostics,
    measurement_boundary: {
      schema: boundary.schema,
      source: boundary.source,
      digest: boundary.computed_digest,
      generated_at: boundary.generated_at ?? now(),
      observed_through: boundary.observed_through,
    },
  };
  applyBoundaryAssertions(report, boundary);
  if (report.gaps.some((gap) => gap.name === "evidence-boundary-drift")) {
    report.claim.reconciliation = "gaps";
    report.claim.claims = report.claim.claims.filter((claim) => claim !== "reconciled");
  }
  return report;
}

function delegationField(report, key) {
  const value = report?.delegation?.[key];
  return Number.isFinite(value) ? String(value) : "unknown";
}

function renderPolicyModeCounts(counts) {
  if (!isPlainObject(counts)) return "unknown";
  return ["fresh", "continue", "fork", "external", "unknown"].map((key) => `${key}=${Number.isFinite(counts[key]) ? counts[key] : "unknown"}`).join(",");
}

function renderMetricGroup(group) {
  if (!group) return "N/A: metric unavailable";
  if (!isFiniteNumber(group.input) || !isFiniteNumber(group.output)) {
    return "N/A: input or output unavailable";
  }
  return `input ${group.input} / output ${group.output}`;
}

function totalsForRole(report, roleKey) {
  return Object.fromEntries(["input", "output", "cache_read", "cache_creation"].map((key) => [key, report.metrics?.[key]?.[roleKey]]));
}

function formatContributorUsageDiagnostics(contributors = []) {
  if (!Array.isArray(contributors) || contributors.length === 0) return "not-reported";
  const maxShown = 8;
  const shown = contributors.slice(0, maxShown).map((contributor) => {
    const source = contributor.usage_source ?? "not-reported";
    const reconciliation = contributor.usage_reconciliation?.status ?? "unknown";
    const attribution = contributor.usage_attribution?.status ?? "unknown";
    const segmentCount = Array.isArray(contributor.usage_segments) ? contributor.usage_segments.length : 0;
    if (contributor.role === "external-reviewer" && contributor.host === "codex") {
      return `${contributor.role}/${contributor.host}:source=${contributor.reviewer_source ?? "not-reported"},usage_source=${source},reconciliation=${reconciliation},attribution=${attribution},segments=${segmentCount}`;
    }
    return `${contributor.role}/${contributor.host}:source=${source},reconciliation=${reconciliation},attribution=${attribution},segments=${segmentCount}`;
  });
  const omitted = contributors.length - shown.length;
  return `${shown.join("; ")}${omitted > 0 ? `; +${omitted} contributor(s) omitted` : ""}`;
}

/** Stable Markdown projection; only reason codes and sanitized boundary basename are rendered. */
export function renderLineageSummaryMarkdown(report, { includeGaps = true } = {}) {
  const claims = report?.claim?.claims?.length ? report.claim.claims.join(",") : "none";
  const gapNames = [...new Set((report?.gaps ?? []).map((gap) => gap.name))];
  const boundary = report?.measurement_boundary ?? {};
  const lines = [
    `- schema: ${report?.schema ?? LINEAGE_REPORT_SCHEMA}`,
    `- lookup: ${report?.claim?.lookup ?? "unavailable"}`,
    `- scope: ${report?.claim?.scope ?? "unavailable"}`,
    `- coverage: ${report?.claim?.coverage ?? "unavailable"}`,
    `- terminality: ${report?.claim?.terminality ?? "unknown"}`,
    `- reconciliation: ${report?.claim?.reconciliation ?? "unavailable"}`,
    `- claims: ${claims}`,
    `- root_sessions: ${report?.counts?.root_sessions ?? 0}`,
    `- descendant_sessions: ${report?.counts?.descendant_sessions ?? 0}`,
    `- external_reviewer_sessions: ${report?.counts?.external_reviewer_sessions ?? 0}`,
    `- dispatch_rows: ${report?.counts?.dispatch_rows ?? 0}`,
    `- spawn_events: ${report?.counts?.spawn_events ?? 0}`,
    `- work_lane_fresh_total: ${delegationField(report, "work_lane_fresh_total")}`,
    `- peak_runtime_native_concurrency: ${delegationField(report, "peak_runtime_native_concurrency")}`,
    `- child_round_trips: ${delegationField(report, "child_round_trips")}`,
    `- continue_ratio: ${delegationField(report, "continue_ratio")}`,
    `- policy_mode: ${renderPolicyModeCounts(report?.delegation?.policy_mode_counts)}`,
    `- root_totals: ${renderMetricGroup(totalsForRole(report, "root"))}`,
    `- descendant_totals: ${renderMetricGroup(totalsForRole(report, "descendants"))}`,
    `- external_reviewer_totals: ${renderMetricGroup(totalsForRole(report, "external_reviewers"))}`,
    `- lineage_totals: ${renderMetricGroup(totalsForRole(report, "lineage_inclusive"))}`,
    `- contributor_usage: ${formatContributorUsageDiagnostics(report?.contributors)}`,
    "- efficiency_verdict: not-comparable",
    "- baseline: N/A: no equivalent lineage-inclusive baseline",
    "- quota_impact: N/A: no provider authority",
    "- quota_authority: N/A: host does not expose quota conversion authority",
  ];
  for (const reviewer of report?.contributors ?? []) {
    if (reviewer.role !== "external-reviewer" || reviewer.host !== "codex") continue;
    const metric = (key) => isFiniteNumber(reviewer[key])
      ? reviewer[key]
      : reviewer[key]?.state === "number" ? reviewer[key].value : reviewer[key]?.state ?? "unavailable";
    lines.push(`- reviewer: ${reviewer.host}/${reviewer.session_id} input ${metric("input")} / output ${metric("output")} / cache_read ${metric("cache_read")} / source ${reviewer.reviewer_source ?? "unavailable"} / usage_source ${reviewer.usage_source ?? "not-reported"}`);
  }
  if (includeGaps) lines.push(`- gaps: ${gapNames.length ? gapNames.join(",") : "無"}`);
  if (boundary.source) lines.push(`- measurement_boundary_source: ${path.basename(boundary.source)}`);
  if (boundary.digest) lines.push(`- measurement_boundary_digest: ${boundary.digest}`);
  if (boundary.generated_at) lines.push(`- generated_at: ${boundary.generated_at}`);
  if (report?.evidence_status) lines.push(`- evidence_status: ${report.evidence_status}`);
  return lines.join("\n");
}
