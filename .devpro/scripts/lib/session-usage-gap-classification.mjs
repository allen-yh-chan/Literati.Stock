const SUPPORTED_CODEX_METRICS = Object.freeze(["input", "output", "cache_read"]);
const ALL_LINEAGE_METRICS = Object.freeze(["input", "output", "cache_read", "cache_creation", "cost_usd"]);

const RAW_CODEX_METRIC_MAP = Object.freeze({
  input_tokens: ["input"],
  cached_input_tokens: ["input", "cache_read"],
  cache_write_input_tokens: ["input", "cache_creation"],
  output_tokens: ["output"],
  reasoning_output_tokens: ["output"],
  total_tokens: ["input", "output"],
});

const EFFECTS = Object.freeze({
  "codex-thread-identity-unresolved": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: SUPPORTED_CODEX_METRICS },
  "lineage-identity-collision": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "lineage-edge-unresolved": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "codex-descendant-usage-missing": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "external-reviewer-usage-unavailable": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "codex-root-window-unresolved": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "codex-session-meta-timestamp-unresolved": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "codex-lineage-directory-read-failed": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "lineage-metadata-read-failed": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "codex-spawn-observability-unverified": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "session-usage-unavailable": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "contributor-role-collision": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "lineage-root-unavailable": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "lineage-cycle-detected": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "lineage-depth-cap-hit": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "lineage-node-cap-hit": { coverage: "incomplete", reconciliation: "unavailable", attribution: "unverified", affected_metrics: ALL_LINEAGE_METRICS },
  "collapsed-deduped-unconvertible": { coverage: "incomplete", reconciliation: "gaps", attribution: "preserve", affected_metrics: ALL_LINEAGE_METRICS },

  "codex-response-usage-conflict": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", metric_source: "codex-counters" },
  "codex-usage-cumulative-missing": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", metric_source: "codex-counters" },
  "codex-usage-cumulative-mismatch": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", metric_source: "codex-counters" },
  "codex-usage-value-invalid": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", metric_source: "codex-counters" },
  "codex-response-identity-unresolved": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", affected_metrics: SUPPORTED_CODEX_METRICS },
  "codex-usage-mixed-unresolved": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", affected_metrics: SUPPORTED_CODEX_METRICS },
  "input-mismatch": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", affected_metrics: ["input"] },
  "output-mismatch": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", affected_metrics: ["output"] },
  "cache-read-unreconciled": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", affected_metrics: ["cache_read"] },
  "no-total-token-usage": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", affected_metrics: SUPPORTED_CODEX_METRICS },
  "cache-write-input-tokens-nonzero": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", affected_metrics: ["input", "cache_creation"] },
  "malformed-jsonl-line": { coverage: "incomplete", reconciliation: "gaps", attribution: "preserve", affected_metrics: SUPPORTED_CODEX_METRICS },
  "codex-token-outside-turn": { coverage: "preserve", reconciliation: "preserve", attribution: "unverified", affected_metrics: [] },
  "codex-response-turn-conflict": { coverage: "preserve", reconciliation: "preserve", attribution: "unverified", affected_metrics: [] },

  "codex-response-duplicate": { coverage: "preserve", reconciliation: "preserve", attribution: "preserve", affected_metrics: [] },
  "codex-foreign-thread-proven": { coverage: "preserve", reconciliation: "preserve", attribution: "preserve", affected_metrics: [] },
  "host-cost-unavailable": { coverage: "preserve", reconciliation: "preserve", attribution: "preserve", affected_metrics: [] },
  "lineage-session-open": { coverage: "preserve", reconciliation: "preserve", attribution: "preserve", affected_metrics: [] },
  "lineage-terminality-unknown": { coverage: "preserve", reconciliation: "preserve", attribution: "preserve", affected_metrics: [] },
  "lineage-metric-mismatch": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", metric_source: "lineage-metric" },
  "evidence-boundary-drift": { coverage: "preserve", reconciliation: "gaps", attribution: "preserve", affected_metrics: ALL_LINEAGE_METRICS },
  "lineage-edge-deduped": { coverage: "preserve", reconciliation: "preserve", attribution: "preserve", affected_metrics: [] },
  "lineage-shared-child-deduped": { coverage: "preserve", reconciliation: "preserve", attribution: "preserve", affected_metrics: [] },
  "change-attribution-unverified": { coverage: "preserve", reconciliation: "preserve", attribution: "unverified", affected_metrics: [] },
  "claude-resume-history-deduped": { coverage: "preserve", reconciliation: "preserve", attribution: "preserve", affected_metrics: [] },
});

function unique(values) {
  return [...new Set(values)];
}

function counterMetrics(gap) {
  const keys = Array.isArray(gap?.metrics) ? gap.metrics : [];
  if (keys.length === 0) return [...SUPPORTED_CODEX_METRICS];
  const metrics = [];
  for (const key of keys) metrics.push(...(RAW_CODEX_METRIC_MAP[key] ?? SUPPORTED_CODEX_METRICS));
  return unique(metrics);
}

/**
 * Classify one usage or lineage gap along independent evidence axes.
 * `codex-metering` is supplied by the Codex collector/adapter context, never
 * guessed from a gap-name prefix. Unknown Codex metering gaps block numeric
 * reconciliation while preserving independently proven membership coverage.
 */
export function classifySessionUsageGap(gap, { domain = "lineage" } = {}) {
  const name = typeof gap?.name === "string" ? gap.name : "";
  const known = EFFECTS[name];
  if (known) {
    const affected = known.metric_source === "codex-counters"
      ? counterMetrics(gap)
      : known.metric_source === "lineage-metric"
        ? typeof gap.metric === "string" ? [gap.metric] : [...ALL_LINEAGE_METRICS]
        : [...known.affected_metrics];
    return {
      coverage: known.coverage,
      reconciliation: known.reconciliation,
      attribution: known.attribution,
      affected_metrics: affected,
    };
  }
  if (domain === "codex-metering") {
    return {
      coverage: "preserve",
      reconciliation: "gaps",
      attribution: "preserve",
      affected_metrics: [...SUPPORTED_CODEX_METRICS],
    };
  }
  return {
    coverage: "incomplete",
    reconciliation: "preserve",
    attribution: "preserve",
    affected_metrics: [],
  };
}
