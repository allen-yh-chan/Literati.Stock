import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveCodexDescendantEvidence,
  EVIDENCE_BOUNDARY_SCHEMA,
  LINEAGE_REPORT_SCHEMA,
  buildLineageUsageReport,
  digestEvidenceBoundary,
  parseEvidenceBoundary,
  probeClaudeContextMode,
  probeClaudeLineageMetadata,
  reconcileLineageMetrics,
  renderLineageSummaryMarkdown,
} from "../lib/session-usage-lineage.mjs";
import { enumerateCodexLineageMetadata, parseCodexRollout } from "../lib/session-token-usage.mjs";
import { classifySessionUsageGap } from "../lib/session-usage-gap-classification.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures/session-usage-lineage/lineage-cases.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("session usage gap classification", () => {
  it("classifies every named Codex metering gap across coverage, reconciliation, attribution, and affected metrics", () => {
    const cases = [
      [{ name: "codex-thread-identity-unresolved" }, ["incomplete", "unavailable", "unverified", ["input", "output", "cache_read"]]],
      [{ name: "codex-response-usage-conflict", metrics: ["output_tokens"] }, ["preserve", "gaps", "preserve", ["output"]]],
      [{ name: "codex-usage-mixed-unresolved" }, ["preserve", "gaps", "preserve", ["input", "output", "cache_read"]]],
      [{ name: "codex-usage-cumulative-missing", metrics: ["cached_input_tokens"] }, ["preserve", "gaps", "preserve", ["input", "cache_read"]]],
      [{ name: "codex-usage-cumulative-mismatch", metrics: ["output_tokens"] }, ["preserve", "gaps", "preserve", ["output"]]],
      [{ name: "codex-usage-value-invalid", metrics: ["reasoning_output_tokens"] }, ["preserve", "gaps", "preserve", ["output"]]],
      [{ name: "codex-response-identity-unresolved" }, ["preserve", "gaps", "preserve", ["input", "output", "cache_read"]]],
      [{ name: "codex-response-turn-conflict" }, ["preserve", "preserve", "unverified", []]],
      [{ name: "codex-token-outside-turn" }, ["preserve", "preserve", "unverified", []]],
      [{ name: "input-mismatch" }, ["preserve", "gaps", "preserve", ["input"]]],
      [{ name: "output-mismatch" }, ["preserve", "gaps", "preserve", ["output"]]],
      [{ name: "cache-read-unreconciled" }, ["preserve", "gaps", "preserve", ["cache_read"]]],
      [{ name: "no-total-token-usage" }, ["preserve", "gaps", "preserve", ["input", "output", "cache_read"]]],
      [{ name: "cache-write-input-tokens-nonzero" }, ["preserve", "gaps", "preserve", ["input", "cache_creation"]]],
      [{ name: "malformed-jsonl-line" }, ["incomplete", "gaps", "preserve", ["input", "output", "cache_read"]]],
      [{ name: "codex-descendant-usage-missing" }, ["incomplete", "unavailable", "unverified", ["input", "output", "cache_read", "cache_creation", "cost_usd"]]],
      [{ name: "lineage-identity-collision" }, ["incomplete", "unavailable", "unverified", ["input", "output", "cache_read", "cache_creation", "cost_usd"]]],
      [{ name: "codex-response-duplicate" }, ["preserve", "preserve", "preserve", []]],
      [{ name: "codex-foreign-thread-proven" }, ["preserve", "preserve", "preserve", []]],
      [{ name: "host-cost-unavailable" }, ["preserve", "preserve", "preserve", []]],
    ];

    for (const [gap, expected] of cases) {
      const effect = classifySessionUsageGap(gap, { domain: "codex-metering" });
      assert.deepEqual([effect.coverage, effect.reconciliation, effect.attribution, effect.affected_metrics], expected, gap.name);
    }
    assert.deepEqual(classifySessionUsageGap({ name: "future-codex-metering-gap" }, { domain: "codex-metering" }), {
      coverage: "preserve",
      reconciliation: "gaps",
      attribution: "preserve",
      affected_metrics: ["input", "output", "cache_read"],
    });
  });

  it("Codex metering gaps do not erase proven membership coverage", () => {
    const root = fixture.sessions.root;
    const adapter = {
      enumerateMetadata: () => ({ nodes: [], edges: [], spawn_events: 0, spawn_observability: "complete", gaps: [] }),
      readSessionUsage: () => ({
        available: true,
        totals: root.usage,
        cost_usd: null,
        usage_source: "token-usage-record",
        usage_segments: [{ source: "token-usage-record", thread_attribution: "root", segment_index: 0, totals: root.usage, reconciliation: "unverified" }],
        usage_reconciliation: { status: "unverified" },
        usage_attribution: { status: "unverified", unassigned_response_count: 1, unknown_thread_event_count: 0 },
        field_availability: { input: "available", output: "available", cache_read: "available", cache_creation: "unsupported-by-host", cost_usd: "unsupported-by-host" },
        terminality: "terminal",
        gaps: [{ name: "codex-response-usage-conflict", metrics: ["output_tokens"] }],
      }),
    };
    const report = buildLineageUsageReport({
      roots: [root],
      boundary: { scope: "session-wide" },
      hostAdapters: { codex: adapter },
    });

    assert.equal(report.claim.coverage, "lineage-complete");
    assert.equal(report.claim.reconciliation, "gaps");
    assert.ok(!report.claim.claims.includes("reconciled"));
    const conflict = report.gaps.find((gap) => gap.name === "codex-response-usage-conflict");
    assert.deepEqual(conflict.axis_effects, {
      coverage: "preserve",
      reconciliation: "gaps",
      attribution: "preserve",
      affected_metrics: ["output"],
    });
    const contributor = report.contributors.find((item) => item.role === "root");
    assert.equal(contributor.usage_source, "token-usage-record");
    assert.equal(contributor.usage_segments.length, 1);
    assert.equal(contributor.usage_reconciliation.status, "unverified");
    assert.equal(contributor.usage_attribution.status, "unverified");
    assert.ok(renderLineageSummaryMarkdown(report).includes("contributor_usage: root/codex:source=token-usage-record,reconciliation=unverified,attribution=unverified,segments=1"));
  });

  it("defaults unknown Codex metering gaps to reconciliation-blocking without erasing proven membership", () => {
    const root = fixture.sessions.root;
    const adapter = {
      enumerateMetadata: () => ({ nodes: [], edges: [], spawn_events: 0, spawn_observability: "complete", gaps: [] }),
      readSessionUsage: () => ({
        available: true,
        totals: root.usage,
        cost_usd: null,
        field_availability: { input: "available", output: "available", cache_read: "available", cache_creation: "unsupported-by-host", cost_usd: "unsupported-by-host" },
        terminality: "terminal",
        gaps: [{ name: "future-codex-metering-gap" }],
      }),
    };
    const report = buildLineageUsageReport({
      roots: [root],
      boundary: { scope: "session-wide" },
      hostAdapters: { codex: adapter },
    });

    assert.equal(report.claim.coverage, "lineage-complete");
    assert.equal(report.claim.reconciliation, "gaps");
    assert.deepEqual(report.gaps.find((gap) => gap.name === "future-codex-metering-gap").axis_effects, {
      coverage: "preserve",
      reconciliation: "gaps",
      attribution: "preserve",
      affected_metrics: ["input", "output", "cache_read"],
    });
  });
});

function identity(session) {
  return `${session.host}:${session.session_id}`;
}

function memoryAdapter({ sessions, edges, spawnObservability = "complete", spawnEvents = edges.length }) {
  const byIdentity = new Map(sessions.map((session) => [identity(session), session]));
  return {
    enumerateMetadata() {
      return {
        nodes: sessions,
        edges: edges.map((edge) => ({
          parent_identity: edge.parent_identity ?? identity(fixture.sessions[edge.parent]),
          child_identity: edge.child_identity ?? identity(fixture.sessions[edge.child]),
          evidence_digest: edge.evidence_digest,
        })),
        spawn_events: spawnEvents,
        spawn_observability: spawnObservability,
        gaps: [],
      };
    },
    readSessionUsage({ host, session_id }) {
      const session = byIdentity.get(`${host}:${session_id}`);
      if (!session) return { available: false, reason: "fixture-session-unresolved" };
      return {
        available: true,
        session: session_id,
        usage_source: session.usage_source ?? null,
        totals: session.usage,
        cost_usd: session.cost_usd ?? null,
        field_availability: {
          input: "available",
          output: "available",
          cache_read: session.usage.cache_read === null ? "unsupported-by-host" : "available",
          cache_creation: session.usage.cache_creation === null ? "unsupported-by-host" : "available",
          cost_usd: session.cost_usd == null ? "unsupported-by-host" : "available"
        },
        terminality: session.terminality ?? "unknown",
        gaps: []
      };
    }
  };
}

function reportFor(edges, { sessions = Object.values(fixture.sessions), limits, spawnObservability, spawnEvents } = {}) {
  return buildLineageUsageReport({
    roots: [fixture.sessions.root],
    externalSessions: [],
    boundary: { scope: "session-wide" },
    hostAdapters: { codex: memoryAdapter({ sessions, edges, spawnObservability, spawnEvents }) },
    limits,
    now: () => "2026-09-02T00:00:00Z",
  });
}

describe("T2 fixture prove-it", () => {
  it("parses the redacted fixture independently of the lineage implementation", () => {
    assert.equal(fixture.schema, "devpro-lineage-usage-fixture/v1");
    assert.equal(fixture.discussion_2411.descendant_usage.length, 34);
    assert.equal(fixture.privacy_markers.email, "EMAIL_ACCOUNT_MARKER_SENTINEL");
  });

  it("requires the named lineage graph API to count child and grandchild exactly once", () => {
    const report = reportFor(fixture.graph_cases.recursive);
    assert.equal(report.schema, LINEAGE_REPORT_SCHEMA);
    assert.deepEqual(report.counts, {
      root_sessions: 1,
      descendant_sessions: 2,
      external_reviewer_sessions: 0,
      dispatch_rows: 0,
      spawn_events: 2,
    });
    assert.equal(report.metrics.input.lineage_inclusive, 160);
    assert.equal(report.claim.coverage, "lineage-complete");
  });

  it("deduplicates exact edges and legal shared children without degrading coverage", () => {
    const duplicate = reportFor(fixture.graph_cases.duplicate);
    assert.equal(duplicate.counts.descendant_sessions, 1);
    assert.equal(duplicate.claim.coverage, "lineage-complete");
    assert.ok(duplicate.diagnostics.some((item) => item.name === "lineage-edge-deduped"));

    const shared = reportFor(fixture.graph_cases.shared);
    assert.equal(shared.counts.descendant_sessions, 2);
    assert.equal(shared.claim.coverage, "lineage-complete");
    assert.ok(shared.diagnostics.some((item) => item.name === "lineage-shared-child-deduped"));
  });

  it("fails closed for cycle, identity collision, unresolved edge and node cap", () => {
    const cycle = reportFor(fixture.graph_cases.cycle);
    assert.equal(cycle.claim.coverage, "lineage-incomplete");
    assert.ok(cycle.gaps.some((gap) => gap.name === "lineage-cycle-detected"));

    const collisionSessions = [
      fixture.sessions.root,
      fixture.sessions.child,
      { ...fixture.sessions.child, carrier_digest: "conflicting-carrier", usage: { ...fixture.sessions.child.usage, input: 999 } },
    ];
    const collision = reportFor(fixture.graph_cases.duplicate.slice(0, 1), { sessions: collisionSessions });
    assert.equal(collision.claim.coverage, "lineage-incomplete");
    assert.ok(collision.gaps.some((gap) => gap.name === "lineage-identity-collision"));

    const unresolved = reportFor(fixture.graph_cases.unresolved);
    assert.equal(unresolved.claim.coverage, "lineage-incomplete");
    assert.ok(unresolved.gaps.some((gap) => gap.name === "lineage-edge-unresolved"));

    const capped = reportFor(fixture.graph_cases.recursive, { limits: { max_nodes: 2 } });
    assert.equal(capped.counts.descendant_sessions, 1);
    assert.ok(capped.gaps.some((gap) => gap.name === "lineage-node-cap-hit"));
  });

  it("treats only complete zero-spawn observation as positive evidence", () => {
    for (const item of fixture.spawn_observability) {
      const report = reportFor([], { spawnObservability: item.state, spawnEvents: item.spawn_events });
      if (item.expected_complete) assert.equal(report.claim.coverage, "lineage-complete");
      else {
        assert.equal(report.claim.coverage, "lineage-incomplete");
        assert.ok(report.gaps.some((gap) => gap.name === item.expected_gap));
      }
    }
  });

  // #2627 / D1 — harden_gap / collapsed-deduped-unconvertible blocks lineage-complete end-to-end.
  it("blocks lineage-complete when session usage carries collapsed-deduped-unconvertible", () => {
    const sessions = [fixture.sessions.root];
    const byIdentity = new Map(sessions.map((session) => [identity(session), session]));
    const adapter = {
      enumerateMetadata() {
        return {
          nodes: sessions,
          edges: [],
          spawn_events: 0,
          spawn_observability: "complete",
          gaps: [],
        };
      },
      readSessionUsage({ host, session_id }) {
        const session = byIdentity.get(`${host}:${session_id}`);
        assert.ok(session);
        return {
          available: true,
          session: session_id,
          totals: session.usage,
          cost_usd: session.cost_usd ?? null,
          field_availability: {
            input: "available",
            output: "available",
            cache_read: session.usage.cache_read === null ? "unsupported-by-host" : "available",
            cache_creation: session.usage.cache_creation === null ? "unsupported-by-host" : "available",
            cost_usd: session.cost_usd == null ? "unsupported-by-host" : "available",
          },
          terminality: session.terminality ?? "terminal",
          gaps: [{ name: "collapsed-deduped-unconvertible" }],
        };
      },
    };
    const baseline = reportFor([]);
    assert.equal(baseline.claim.coverage, "lineage-complete", "fixture baseline stays complete without the harden gap");
    const report = buildLineageUsageReport({
      roots: [fixture.sessions.root],
      externalSessions: [],
      boundary: { scope: "session-wide" },
      hostAdapters: { codex: adapter },
      now: () => "2026-09-02T00:00:00Z",
    });
    assert.equal(report.claim.coverage, "lineage-incomplete");
    assert.ok(report.gaps.some((gap) => gap.name === "collapsed-deduped-unconvertible"));
    assert.ok(!report.claim.claims.includes("lineage-complete"));
  });

  it("fails closed with a named unavailable root instead of emitting vacuous claims", () => {
    const report = buildLineageUsageReport({
      roots: [],
      externalSessions: [],
      boundary: { scope: "session-wide" },
      hostAdapters: {},
    });
    assert.equal(report.available, false);
    assert.equal(report.claim.lookup, "unavailable");
    assert.ok(report.gaps.some((gap) => gap.name === "lineage-root-unavailable"));
    assert.ok(["lineage-incomplete", "unavailable"].includes(report.claim.coverage));
    assert.ok(["gaps", "unavailable"].includes(report.claim.reconciliation));
    assert.deepEqual(report.claim.claims, []);
  });

  it("Missing transcript uses the snapshot in both report modes", () => {
    const reviewerId = "96969696-9696-4696-8696-969696969696";
    const snapshot = {
      totals: { input: 75, output: 17, cache_read: 45, cache_creation: null },
      source: "reviewer-manifest:turn.completed.usage",
    };
    const rootSessions = [fixture.sessions.root];
    const report = buildLineageUsageReport({
      roots: [fixture.sessions.root],
      externalSessions: [{
        host: "codex",
        session_id: reviewerId,
        dispatch_id: "dispatch-lineage-snapshot",
        usage_snapshot: snapshot,
      }],
      boundary: { scope: "current-change", terminality: "open" },
      hostAdapters: { codex: memoryAdapter({ sessions: rootSessions, edges: [], spawnEvents: 0 }) },
      now: () => "2026-09-02T00:00:00Z",
    });
    const reviewer = report.contributors.find((item) => item.role === "external-reviewer");
    assert.equal(reviewer.input, 75);
    assert.equal(reviewer.output, 17);
    assert.equal(reviewer.cache_read, 45);
    assert.equal(reviewer.reviewer_source, "reviewer-manifest:turn.completed.usage");
    const markdown = renderLineageSummaryMarkdown(report);
    assert.match(markdown, /reviewer-manifest:turn\.completed\.usage/);
    assert.match(markdown, /input 75/);
    assert.match(markdown, /output 17/);
    assert.match(markdown, /cache_read 45/);
  });

  it("Available transcript remains authoritative over the reviewer snapshot", () => {
    const reviewerId = "97979797-9797-4797-8797-979797979797";
    const transcriptReviewer = {
      host: "codex",
      session_id: reviewerId,
      usage: { input: 12, output: 4, cache_read: 3, cache_creation: null },
      usage_source: "token-usage-record",
    };
    const report = buildLineageUsageReport({
      roots: [fixture.sessions.root],
      externalSessions: [{
        host: "codex",
        session_id: reviewerId,
        usage_snapshot: {
          totals: { input: 75, output: 17, cache_read: 45, cache_creation: null },
          source: "reviewer-manifest:turn.completed.usage",
        },
      }],
      boundary: { scope: "current-change", terminality: "open" },
      hostAdapters: {
        codex: memoryAdapter({ sessions: [fixture.sessions.root, transcriptReviewer], edges: [], spawnEvents: 0 }),
      },
      now: () => "2026-09-02T00:00:00Z",
    });
    const reviewer = report.contributors.find((item) => item.role === "external-reviewer");
    assert.equal(reviewer.input, 12);
    assert.equal(reviewer.output, 4);
    assert.equal(reviewer.cache_read, 3);
    assert.equal(reviewer.reviewer_source, "transcript");
    assert.equal(reviewer.usage_source, "token-usage-record");
  });

  it("does not add Claude external reviewer rows to the Codex usage summary", () => {
    const reviewerId = "98989898-9898-4898-8898-989898989898";
    const transcriptReviewer = {
      host: "claude-code",
      session_id: reviewerId,
      usage: { input: 21, output: 8, cache_read: 5, cache_creation: null },
    };
    const report = buildLineageUsageReport({
      roots: [fixture.sessions.root],
      externalSessions: [{ host: "claude-code", session_id: reviewerId }],
      boundary: { scope: "current-change", terminality: "open" },
      hostAdapters: {
        codex: memoryAdapter({ sessions: [fixture.sessions.root], edges: [], spawnEvents: 0 }),
        "claude-code": memoryAdapter({ sessions: [transcriptReviewer], edges: [], spawnEvents: 0 }),
      },
      now: () => "2026-09-02T00:00:00Z",
    });
    const reviewer = report.contributors.find((item) => item.role === "external-reviewer");
    assert.equal(reviewer.input, 21);
    assert.equal(reviewer.output, 8);
    assert.doesNotMatch(
      renderLineageSummaryMarkdown(report),
      new RegExp("^- reviewer: claude-code/" + reviewerId + " ", "m"),
    );
  });

  it("classifies Claude fresh/fork/resume/nested/unknown from evidence only", () => {
    for (const item of fixture.claude_modes) {
      const result = probeClaudeContextMode(item.evidence);
      assert.equal(result.mode, item.expected);
      if (item.expected_gap) assert.ok(result.gaps.some((gap) => gap.name === item.expected_gap));
    }
  });

  it("deduplicates Claude resume history and names unresolved nested carriers", () => {
    const probe = probeClaudeLineageMetadata({
      parent: { host: "claude-code", session_id: "00000000-0000-4000-8000-000000000010" },
      relationships: [
        { session_id: "00000000-0000-4000-8000-000000000011", trusted_mode: "resume", terminal_message_id: "terminal-1" },
        { session_id: "00000000-0000-4000-8000-000000000011", trusted_mode: "resume", terminal_message_id: "terminal-1" },
        { session_id: "00000000-0000-4000-8000-000000000012", nested_call: true },
      ],
    });
    assert.equal(probe.nodes.length, 1);
    assert.equal(probe.edges.length, 1);
    assert.ok(probe.diagnostics.some((item) => item.name === "claude-resume-history-deduped"));
    assert.ok(probe.gaps.some((item) => item.name === "claude-nested-lineage-unresolved"));
    assert.equal(probe.spawn_observability, "partial");
  });

  it("reports Codex spawn observability independently from token rows", () => {
    const complete = parseCodexRollout([
      JSON.stringify({ timestamp: "2026-09-02T00:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
      JSON.stringify({ timestamp: "2026-09-02T00:00:01Z", type: "response_item", payload: { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ agent_type: "dp-programmer" }) } }),
      JSON.stringify({ timestamp: "2026-09-02T00:00:02Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
    ].join("\n"));
    assert.equal(complete.spawn_events, 1);
    assert.equal(complete.open_turn_count, 0);
    assert.equal(complete.last_event_ts, "2026-09-02T00:00:02Z");
    assert.equal(complete.spawn_observability, "complete");

    const partial = parseCodexRollout("{ malformed");
    assert.equal(partial.spawn_observability, "partial");

    const malformedSpawn = parseCodexRollout(JSON.stringify({
      timestamp: "2026-09-02T00:00:03Z",
      type: "response_item",
      payload: { type: "function_call", name: "spawn_agent", arguments: "{ malformed" },
    }));
    assert.equal(malformedSpawn.spawn_events, 1);
    assert.equal(malformedSpawn.spawn_observability, "partial");
  });

  it("names an unreadable nested Codex lineage directory and cannot claim complete observability", () => {
    const rootId = "00000000-0000-4000-8000-000000000026";
    const root = path.join(path.parse(process.cwd()).root, "enc");
    const base = path.join(root, "sessions");
    const rootFile = path.join(base, "2026", "09", "02", `rollout-root-${rootId}.jsonl`);
    const directories = new Map([
      [base, ["2026", "unreadable"]],
      [path.join(base, "2026"), ["09"]],
      [path.join(base, "2026", "09"), ["02"]],
      [path.join(base, "2026", "09", "02"), [path.basename(rootFile)]],
    ]);
    const indexed = enumerateCodexLineageMetadata({
      root,
      rootSessionId: rootId,
      listDir: (directory) => {
        if (directory === path.join(base, "unreadable")) throw new Error("EACCES");
        const entries = directories.get(directory);
        if (!entries) throw new Error("not a directory");
        return entries;
      },
      readPrefix: () => JSON.stringify({
        timestamp: "2026-09-02T12:00:00Z",
        type: "session_meta",
        payload: { id: rootId },
      }),
    });
    assert.ok(indexed.gaps.some((gap) => gap.name === "codex-lineage-directory-read-failed"));
    assert.equal(indexed.spawn_observability, "partial");
  });

  it("indexes Codex session_meta only in the root ±24h window and preserves cap gaps", () => {
    const rootId = "00000000-0000-4000-8000-000000000020";
    const childId = "00000000-0000-4000-8000-000000000021";
    const unrelatedId = "00000000-0000-4000-8000-000000000022";
    const root = path.join(path.parse(process.cwd()).root, "enc");
    const base = path.join(root, "sessions");
    const rootFile = path.join(base, "2026", "09", "02", `rollout-root-${rootId}.jsonl`);
    const childFile = path.join(base, "2026", "09", "02", `rollout-child-${childId}.jsonl`);
    const unrelatedFile = path.join(base, "2026", "09", "01", `rollout-unrelated-${unrelatedId}.jsonl`);
    const oldFile = path.join(base, "2020", "01", "01", "rollout-old.jsonl");
    const directories = new Map([
      [base, ["2020", "2026"]],
      [path.join(base, "2020"), ["01"]],
      [path.join(base, "2020", "01"), ["01"]],
      [path.join(base, "2020", "01", "01"), ["rollout-old.jsonl"]],
      [path.join(base, "2026"), ["09"]],
      [path.join(base, "2026", "09"), ["01", "02"]],
      [path.join(base, "2026", "09", "01"), [path.basename(unrelatedFile)]],
      [path.join(base, "2026", "09", "02"), [path.basename(rootFile), path.basename(childFile)]],
    ]);
    const records = new Map([
      [rootFile, JSON.stringify({ timestamp: "2026-09-02T12:00:00Z", type: "session_meta", payload: { id: rootId } }) + "\nTRANSCRIPT_BODY_MARKER_SENTINEL"],
      [childFile, JSON.stringify({ timestamp: "2026-09-02T12:10:00Z", type: "session_meta", payload: { id: childId, source: { subagent: { thread_spawn: { parent_thread_id: rootId } } } } }) + "\nTRANSCRIPT_BODY_MARKER_SENTINEL"],
      [unrelatedFile, JSON.stringify({ timestamp: "2026-09-01T13:00:00Z", type: "session_meta", payload: { id: unrelatedId } })],
      [oldFile, JSON.stringify({ timestamp: "2020-01-01T00:00:00Z", type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000099" } })],
    ]);
    const prefixSizes = [];
    const indexed = enumerateCodexLineageMetadata({
      root,
      rootSessionId: rootId,
      listDir: (directory) => {
        const entries = directories.get(directory);
        if (!entries) throw new Error("not a directory");
        return entries;
      },
      readPrefix: (file, maxBytes) => {
        prefixSizes.push(maxBytes);
        return records.get(file);
      },
      limits: { max_files: 2, max_meta_record_bytes: 65536, max_total_meta_bytes: 131072 },
    });
    assert.deepEqual(indexed.nodes.map((node) => node.session_id).sort(), [rootId, childId].sort());
    assert.equal(indexed.edges[0].parent_identity, `codex:${rootId}`);
    assert.equal(indexed.edges[0].child_identity, `codex:${childId}`);
    assert.ok(indexed.gaps.some((gap) => gap.name === "lineage-file-cap-hit"));
    assert.ok(prefixSizes.every((size) => size <= 65536));
    assert.ok(!JSON.stringify(indexed).includes("TRANSCRIPT_BODY_MARKER_SENTINEL"));
  });

  it("filters Codex metadata by the exact root timestamp ±24h boundary", () => {
    const rootId = "00000000-0000-4000-8000-000000000023";
    const insideId = "00000000-0000-4000-8000-000000000024";
    const outsideId = "00000000-0000-4000-8000-000000000025";
    const root = path.join(path.parse(process.cwd()).root, "enc");
    const base = path.join(root, "sessions");
    const rootFile = path.join(base, "2026", "09", "02", `rollout-root-${rootId}.jsonl`);
    const insideFile = path.join(base, "2026", "09", "01", `rollout-inside-${insideId}.jsonl`);
    const outsideFile = path.join(base, "2026", "09", "01", `rollout-outside-${outsideId}.jsonl`);
    const directories = new Map([
      [base, ["2026"]],
      [path.join(base, "2026"), ["09"]],
      [path.join(base, "2026", "09"), ["01", "02"]],
      [path.join(base, "2026", "09", "01"), [path.basename(insideFile), path.basename(outsideFile)]],
      [path.join(base, "2026", "09", "02"), [path.basename(rootFile)]],
    ]);
    const records = new Map([
      [rootFile, JSON.stringify({ timestamp: "2026-09-02T12:00:00Z", type: "session_meta", payload: { id: rootId } })],
      [insideFile, JSON.stringify({ timestamp: "2026-09-01T12:00:00Z", type: "session_meta", payload: { id: insideId } })],
      [outsideFile, JSON.stringify({ timestamp: "2026-09-01T11:59:59Z", type: "session_meta", payload: { id: outsideId } })],
    ]);
    const indexed = enumerateCodexLineageMetadata({
      root,
      rootSessionId: rootId,
      listDir: (directory) => {
        const entries = directories.get(directory);
        if (!entries) throw new Error("not a directory");
        return entries;
      },
      readPrefix: (file) => records.get(file),
      limits: { max_files: 10, max_meta_record_bytes: 65536, max_total_meta_bytes: 131072 },
    });
    assert.deepEqual(indexed.nodes.map((node) => node.session_id).sort(), [rootId, insideId].sort());
  });

  it("preserves unavailable metric states and names arithmetic mismatch", () => {
    const metrics = reconcileLineageMetrics({
      root: [{ input: 10, output: 4, cache_creation: { state: "not-applicable", reason: "unsupported-by-host" } }],
      descendants: [{ input: 5, output: 1, cache_creation: { state: "not-applicable", reason: "unsupported-by-host" } }],
      externalReviewers: [{ input: 2, output: 1, cache_creation: { state: "unavailable", reason: "not-reported" } }],
      reported: { input: 18, output: 6 },
    });
    assert.equal(metrics.input.status, "mismatch");
    assert.equal(metrics.input.delta, -1);
    assert.equal(metrics.cache_creation.lineage_inclusive.state, "unavailable");
    assert.ok(metrics.gaps.some((gap) => gap.name === "lineage-metric-mismatch" && gap.metric === "input"));
  });

  it("degrades top-level reconciliation for a supported cache metric mismatch", () => {
    const report = buildLineageUsageReport({
      roots: [fixture.sessions.root],
      externalSessions: [],
      boundary: { scope: "session-wide", reported_metrics: { cache_read: 999 } },
      hostAdapters: {
        codex: memoryAdapter({
          sessions: [fixture.sessions.root],
          edges: [],
          spawnEvents: 0,
        }),
      },
    });
    assert.equal(report.metrics.cache_read.status, "mismatch");
    assert.equal(report.claim.reconciliation, "gaps");
    assert.ok(!report.claim.claims.includes("reconciled"));
  });

  it("reproduces the fixed #2411 arithmetic, dedupes 3 dispatches to 2 reviewers, and detects drift", () => {
    const episode = fixture.discussion_2411;
    const contributorIdentityDigest = createHash("sha256").update(JSON.stringify([
      "root\u0000codex:24110000-0000-4000-8000-000000000001",
      ...Array.from({ length: 34 }, (_, index) => `descendant\u0000codex:24110000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`),
      "external-reviewer\u0000claude-code:24110000-0000-4000-8000-000000000101",
      "external-reviewer\u0000claude-code:24110000-0000-4000-8000-000000000102",
    ].sort())).digest("hex");
    const boundary = parseEvidenceBoundary({
      ...episode.boundary,
      expected: { ...episode.boundary.expected, identity_digest_sha256: contributorIdentityDigest },
    });
    assert.equal(boundary.schema, EVIDENCE_BOUNDARY_SCHEMA);

    const root = { ...episode.boundary.roots[0], usage: episode.root_usage, terminality: "terminal" };
    const descendants = episode.descendant_usage.map((value, index) => ({
      host: "codex",
      session_id: `24110000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
      usage: { input: value, output: 0, cache_read: null, cache_creation: null },
      terminality: "terminal",
    }));
    const externalById = new Map(episode.external_usage.map((usage) => [usage.session_id, {
      host: "claude-code",
      session_id: usage.session_id,
      usage: { input: usage.input, output: usage.output, cache_read: null, cache_creation: null },
      terminality: "terminal",
    }]));
    const allCodex = [root, ...descendants];
    const edges = descendants.map((session, index) => ({
      parent_identity: index === 0 ? identity(root) : identity(descendants[index - 1]),
      child_identity: identity(session),
      evidence_digest: `redacted-edge-${index + 1}`,
    }));
    const report = buildLineageUsageReport({
      roots: [root],
      externalSessions: episode.boundary.external_sessions.map((entry) => ({ ...entry, ...externalById.get(entry.session_id) })),
      boundary,
      hostAdapters: {
        codex: memoryAdapter({ sessions: allCodex, edges }),
        "claude-code": memoryAdapter({ sessions: [...externalById.values()], edges: [], spawnEvents: 0 }),
      },
      now: () => "2026-09-02T00:00:00Z",
    });
    assert.deepEqual(report.counts, {
      root_sessions: 1,
      descendant_sessions: 34,
      external_reviewer_sessions: 2,
      dispatch_rows: 3,
      spawn_events: 34,
    });
    assert.equal(report.evidence_status, "reproduced", JSON.stringify(report.gaps));
    assert.deepEqual(report.metrics.observed_tokens, {
      root: 4735007,
      descendants: 4433007,
      external_reviewers: 48206,
      lineage_inclusive: 9216220,
      status: "reconciled",
      delta: 0,
    });

    const drifted = buildLineageUsageReport({
      roots: [{ ...root, usage: { ...root.usage, input: root.usage.input + 1 } }],
      externalSessions: episode.boundary.external_sessions.map((entry) => ({ ...entry, ...externalById.get(entry.session_id) })),
      boundary,
      hostAdapters: {
        codex: memoryAdapter({ sessions: [{ ...root, usage: { ...root.usage, input: root.usage.input + 1 } }, ...descendants], edges }),
        "claude-code": memoryAdapter({ sessions: [...externalById.values()], edges: [], spawnEvents: 0 }),
      },
      now: () => "2026-09-02T00:00:00Z",
    });
    assert.equal(drifted.evidence_status, "drift");
    assert.ok(drifted.gaps.some((gap) => gap.name === "evidence-boundary-drift"));
    assert.equal(drifted.claim.reconciliation, "gaps");
    assert.ok(!drifted.claim.claims.includes("reconciled"));
    assert.ok(!drifted.claim.claims.includes("reproduced"));

    const identitySwappedDescendants = descendants.map((session, index) => index === 0
      ? { ...session, session_id: "24119999-0000-4000-8000-000000000002" }
      : session);
    const identitySwappedEdges = identitySwappedDescendants.map((session, index) => ({
      parent_identity: index === 0 ? identity(root) : identity(identitySwappedDescendants[index - 1]),
      child_identity: identity(session),
      evidence_digest: `redacted-edge-${index + 1}`,
    }));
    const identityDrifted = buildLineageUsageReport({
      roots: [root],
      externalSessions: episode.boundary.external_sessions.map((entry) => ({ ...entry, ...externalById.get(entry.session_id) })),
      boundary,
      hostAdapters: {
        codex: memoryAdapter({ sessions: [root, ...identitySwappedDescendants], edges: identitySwappedEdges }),
        "claude-code": memoryAdapter({ sessions: [...externalById.values()], edges: [], spawnEvents: 0 }),
      },
      now: () => "2026-09-02T00:00:00Z",
    });
    assert.equal(identityDrifted.evidence_status, "drift");
    assert.ok(identityDrifted.gaps.some((gap) => gap.name === "evidence-boundary-drift"));
  });

  it("requires generated_at and a declared digest on a fixed evidence boundary", () => {
    const withGeneratedAt = {
      ...fixture.discussion_2411.boundary,
      generated_at: "2026-08-30T11:13:26Z",
    };
    const complete = {
      ...withGeneratedAt,
      boundary_digest: digestEvidenceBoundary(withGeneratedAt),
    };
    const withoutGeneratedAt = { ...complete };
    delete withoutGeneratedAt.generated_at;
    const withoutDigest = { ...complete };
    delete withoutDigest.boundary_digest;
    assert.throws(() => parseEvidenceBoundary(withoutGeneratedAt), /generated_at/u);
    assert.throws(() => parseEvidenceBoundary(withoutDigest), /boundary_digest/u);
  });

  it("renders only sanitized boundary identity and no private fixture marker", () => {
    const report = {
      schema: LINEAGE_REPORT_SCHEMA,
      available: true,
      claim: { lookup: "exact", scope: "session-wide", coverage: "lineage-incomplete", terminality: "unknown", reconciliation: "gaps", claims: [] },
      counts: { root_sessions: 1, descendant_sessions: 0, external_reviewer_sessions: 0, dispatch_rows: 0, spawn_events: 0 },
      metrics: {},
      gaps: [{ name: "fixture-gap" }],
      measurement_boundary: { source: "boundary.json", digest: "abc123", generated_at: "2026-09-02T00:00:00Z" },
    };
    const markdown = renderLineageSummaryMarkdown(report);
    for (const marker of Object.values(fixture.privacy_markers)) assert.ok(!markdown.includes(marker));
    assert.match(markdown, /boundary\.json/);
    assert.match(markdown, /abc123/);
  });
});

// ===========================================================================
// T10 (strengthen-subagent-delegation-strategy, design D13): delegation
// telemetry — eight lineage-owned fields derived from evidence only.
// ===========================================================================

import { deriveDelegationTelemetry } from "../lib/session-usage-lineage.mjs";

describe("T10 delegation telemetry (D13 eight fields)", () => {
  const parentId = "00000000-0000-4000-8000-000000000020";
  const childA = "00000000-0000-4000-8000-000000000021";
  const childB = "00000000-0000-4000-8000-000000000022";
  const childNested = "00000000-0000-4000-8000-000000000023";
  const evidence = (overrides) => ({
    agent_type: "dp-programmer",
    spawn_depth: 1,
    dispatch_turns: 1,
    prompt_sha256: "a".repeat(64),
    start_ts: "2026-09-03T01:00:00.000Z",
    end_ts: "2026-09-03T01:10:00.000Z",
    ...overrides,
  });

  it("classifies Claude spawn mode from meta evidence (agent_type + spawn_depth) without tool_input.resume", () => {
    assert.equal(probeClaudeContextMode({ agent_type: "dp-architect", spawn_depth: 1 }).mode, "fresh");
    assert.equal(probeClaudeContextMode({ agent_type: "fork", spawn_depth: 1 }).mode, "fork");
    assert.equal(probeClaudeContextMode({ agent_type: "dp-explorer", spawn_depth: 2 }).mode, "nested");
    const unknown = probeClaudeContextMode({ agent_type: "dp-architect" });
    assert.equal(unknown.mode, "unknown");
    assert.ok(unknown.gaps.some((gap) => gap.name === "claude-context-mode-unknown"));
  });

  it("carries delegation evidence on lineage nodes and never the prompt text", () => {
    const probe = probeClaudeLineageMetadata({
      parent: { host: "claude-code", session_id: parentId },
      relationships: [{ session_id: childA, ...evidence({ dispatch_turns: 3 }) }],
    });
    assert.equal(probe.nodes.length, 1);
    assert.equal(probe.nodes[0].context_mode, "fresh");
    assert.deepEqual(probe.nodes[0].delegation_evidence, evidence({ dispatch_turns: 3 }));
    assert.equal(JSON.stringify(probe).includes("prompt_text"), false);
  });

  it("without admission records: responsibility_id/work_lane_fresh_total are unknown, lane comes from agent_type, counts still measured", () => {
    const result = deriveDelegationTelemetry({
      descendants: [
        { identity: `claude-code:${childA}`, context_mode: "fresh", delegation_evidence: evidence({ dispatch_turns: 3 }) },
        { identity: `claude-code:${childB}`, context_mode: "fresh", delegation_evidence: evidence({ agent_type: "dp-second-reviewer", prompt_sha256: "b".repeat(64), start_ts: "2026-09-03T01:05:00.000Z", end_ts: "2026-09-03T01:20:00.000Z" }) },
      ],
      externals: [{ identity: "codex:00000000-0000-4000-8000-000000000030" }],
      admissionRecords: { available: false, reason: "admission-records-dir-missing" },
      spawnObservable: true,
    });
    const byId = Object.fromEntries(result.per_contributor.map((row) => [row.identity, row]));
    assert.equal(byId[`claude-code:${childA}`].policy_mode, "fresh");
    assert.equal(byId[`claude-code:${childA}`].lane, "work");
    assert.equal(byId[`claude-code:${childA}`].responsibility_id, "unknown");
    assert.equal(byId[`claude-code:${childA}`].replacement_reason, "unknown");
    assert.equal(byId[`claude-code:${childA}`].continuation_turns, 2);
    assert.equal(byId[`claude-code:${childB}`].lane, "review");
    assert.equal(byId["codex:00000000-0000-4000-8000-000000000030"].policy_mode, "external");
    assert.equal(byId["codex:00000000-0000-4000-8000-000000000030"].lane, "review");
    assert.equal(result.work_lane_fresh_total, "unknown");
    assert.equal(result.peak_runtime_native_concurrency, 2);
    assert.equal(result.child_round_trips, 4);
    assert.equal(result.continue_ratio, 0.5);
    assert.deepEqual(result.policy_mode_counts, { fresh: 2, continue: 2, fork: 0, external: 1, unknown: 0 });
    assert.ok(result.gaps.some((gap) => gap.name === "admission-records-unavailable"));
  });

  it("with admission records: matches by prompt_sha256, derives responsibility_id/lane/replacement_reason and work_lane_fresh_total", () => {
    const records = [
      { record_id: "r1", responsibility_id: "brd", instance_mode: "fresh", role: "dp-analyst", admitted_at: "2026-09-03T00:10:00Z", prompt_sha256: "c".repeat(64) },
      { record_id: "r2", responsibility_id: "impl", instance_mode: "fresh", role: "dp-programmer", admitted_at: "2026-09-03T00:50:00Z", prompt_sha256: "a".repeat(64) },
      { record_id: "r3", responsibility_id: "impl", instance_mode: "fresh", role: "dp-programmer", admitted_at: "2026-09-03T01:30:00Z", prompt_sha256: "d".repeat(64), replacement_reason: "context-growth" },
      { record_id: "r4", responsibility_id: "impl", instance_mode: "fresh", role: "dp-programmer", admitted_at: "2026-09-03T02:30:00Z", prompt_sha256: "e".repeat(64) },
      { record_id: "r5", responsibility_id: "second", instance_mode: "fresh", role: "dp-second-reviewer", admitted_at: "2026-09-03T02:40:00Z", prompt_sha256: "f".repeat(64) },
    ];
    const result = deriveDelegationTelemetry({
      descendants: [
        { identity: `claude-code:${childA}`, context_mode: "fresh", delegation_evidence: evidence() },
        { identity: `claude-code:${childB}`, context_mode: "fresh", delegation_evidence: evidence({ prompt_sha256: "d".repeat(64), start_ts: "2026-09-03T01:31:00.000Z", end_ts: "2026-09-03T01:40:00.000Z" }) },
        { identity: `claude-code:${childNested}`, context_mode: "fresh", delegation_evidence: evidence({ prompt_sha256: "e".repeat(64), start_ts: "2026-09-03T02:31:00.000Z", end_ts: "2026-09-03T02:40:00.000Z" }) },
      ],
      externals: [],
      admissionRecords: { available: true, records, malformed: 0 },
      spawnObservable: true,
    });
    const byId = Object.fromEntries(result.per_contributor.map((row) => [row.identity, row]));
    assert.equal(byId[`claude-code:${childA}`].responsibility_id, "impl");
    assert.equal(byId[`claude-code:${childA}`].replacement_reason, null, "first fresh for the responsibility: no replacement");
    assert.equal(byId[`claude-code:${childB}`].replacement_reason, "context-growth", "closed-set value from the record");
    assert.equal(byId[`claude-code:${childNested}`].replacement_reason, "unknown", "replacement without a recorded reason is unknown, not null");
    assert.equal(result.work_lane_fresh_total, 4, "review-lane record (dp-second-reviewer) excluded");
    assert.equal(result.peak_runtime_native_concurrency, 1);
  });

  // I-08 (PR #2473 second cross-model round): the sweep-line sorted the `-1` end
  // event before the `+1` start event at an equal timestamp, so a child whose
  // interval is a single instant — one assistant output, start === end —
  // decremented before it incremented and never raised the running count. The
  // report then stated peak 0 while child evidence was right there, which is the
  // inference from present-but-degenerate evidence BRD S2 forbids.
  it("a child whose interval is a single instant still counts toward peak concurrency", () => {
    const instant = "2026-09-03T00:30:00.000Z";
    const single = deriveDelegationTelemetry({
      descendants: [{ identity: `claude-code:${childA}`, context_mode: "fresh", delegation_evidence: evidence({ start_ts: instant, end_ts: instant }) }],
      externals: [],
      admissionRecords: { available: false, reason: "not-provided" },
      spawnObservable: true,
    });
    assert.equal(single.peak_runtime_native_concurrency, 1, "one observed child is never peak 0");
    const two = deriveDelegationTelemetry({
      descendants: [
        { identity: `claude-code:${childA}`, context_mode: "fresh", delegation_evidence: evidence({ start_ts: instant, end_ts: instant }) },
        { identity: `claude-code:${childB}`, context_mode: "fresh", delegation_evidence: evidence({ prompt_sha256: "d".repeat(64), start_ts: instant, end_ts: instant }) },
      ],
      externals: [],
      admissionRecords: { available: false, reason: "not-provided" },
      spawnObservable: true,
    });
    assert.equal(two.peak_runtime_native_concurrency, 2, "two children sharing one instant are concurrent");
  });

  // I-07 (PR #2473 second cross-model round): `readChangeAdmissionRecords` sets
  // `truncated: true` past ADMISSION_RECORD_LIMIT and nothing consumed it, so a
  // corpus cut to the first N was counted as the whole corpus.
  it("a truncated admission-record corpus is a named gap, not complete evidence", () => {
    const records = [
      { record_id: "r1", responsibility_id: "impl", instance_mode: "fresh", role: "dp-programmer", admitted_at: "2026-09-03T00:50:00Z", prompt_sha256: "a".repeat(64) },
    ];
    const args = {
      descendants: [{ identity: `claude-code:${childA}`, context_mode: "fresh", delegation_evidence: evidence() }],
      externals: [],
      spawnObservable: true,
    };
    const complete = deriveDelegationTelemetry({ ...args, admissionRecords: { available: true, records, malformed: 0 } });
    assert.deepEqual(complete.gaps.filter((gap) => gap.name === "admission-records-truncated"), [], "a complete corpus raises no truncation gap");
    const truncated = deriveDelegationTelemetry({ ...args, admissionRecords: { available: true, records, malformed: 0, truncated: true } });
    assert.deepEqual(
      truncated.gaps.filter((gap) => gap.name === "admission-records-truncated"),
      [{ name: "admission-records-truncated", limit: 500 }],
      "a corpus the loader itself cut short must surface as a named gap",
    );
  });

  it("continue records do not inflate work_lane_fresh_total and raise no incompleteness gap (D34)", () => {
    const freshOnly = [
      { record_id: "r1", responsibility_id: "impl", instance_mode: "fresh", role: "dp-programmer", admitted_at: "2026-09-03T00:50:00Z", prompt_sha256: "a".repeat(64) },
    ];
    const withContinuations = [
      ...freshOnly,
      { record_id: "r2", responsibility_id: "impl", instance_mode: "continue", parent_record_id: "r1", role: "dp-programmer", role_binding: "cooperative-only", admitted_at: "2026-09-03T01:50:00Z", prompt_sha256: "z".repeat(64) },
      { record_id: "r3", responsibility_id: "impl", instance_mode: "continue", parent_record_id: "r2", role: "dp-programmer", role_binding: "cooperative-only", admitted_at: "2026-09-03T02:50:00Z", prompt_sha256: "y".repeat(64) },
    ];
    const derive = (records) => deriveDelegationTelemetry({
      descendants: [{ identity: `claude-code:${childA}`, context_mode: "fresh", delegation_evidence: evidence() }],
      externals: [],
      admissionRecords: { available: true, records, malformed: 0 },
      spawnObservable: true,
    });
    const baseline = derive(freshOnly);
    const continued = derive(withContinuations);
    assert.equal(baseline.work_lane_fresh_total, 1);
    assert.equal(continued.work_lane_fresh_total, baseline.work_lane_fresh_total, "continue records are not fresh work-lane spawns");
    assert.deepEqual(
      continued.gaps.map((gap) => gap.name).filter((name) => name.startsWith("admission-records-")),
      [],
      "continuation records raise no admission-records-* gap",
    );
    assert.deepEqual(
      continued.gaps.map((gap) => gap.name).filter((name) => name === "codex-role-carrier-unverified"),
      [],
      "cooperative-only role binding on a Claude continuation is not a Codex carrier gap",
    );
  });

  it("records a codex-role-carrier-unverified gap for Codex cooperative-only records and none for Claude host-verified ones (D6 2.1a)", () => {
    const codex = deriveDelegationTelemetry({
      descendants: [],
      externals: [],
      admissionRecords: { available: true, records: [{ record_id: "r1", host: "codex", role: "dp-reviewer", role_binding: "cooperative-only", instance_mode: "fresh", responsibility_id: "review", prompt_sha256: "a".repeat(64) }], malformed: 0 },
      spawnObservable: true,
    });
    assert.deepEqual(codex.gaps.filter((gap) => gap.name === "codex-role-carrier-unverified"), [{ name: "codex-role-carrier-unverified", records: 1 }]);
    const claude = deriveDelegationTelemetry({
      descendants: [],
      externals: [],
      admissionRecords: { available: true, records: [{ record_id: "r2", host: "claude-code", role: "dp-reviewer", role_binding: "host-verified", instance_mode: "fresh", responsibility_id: "review", prompt_sha256: "b".repeat(64) }], malformed: 0 },
      spawnObservable: true,
    });
    assert.equal(claude.gaps.some((gap) => gap.name === "codex-role-carrier-unverified"), false);
  });

  it("never serializes missing evidence as 0: incomplete observation → unknown, complete zero-spawn → 0, ratio undefined → unknown", () => {
    const incomplete = deriveDelegationTelemetry({
      descendants: [{ identity: `claude-code:${childA}`, context_mode: "unknown", delegation_evidence: null }],
      externals: [],
      admissionRecords: { available: true, records: [], malformed: 0 },
      spawnObservable: false,
    });
    assert.equal(incomplete.per_contributor[0].policy_mode, "unknown");
    assert.ok(incomplete.gaps.some((gap) => gap.name === "policy-mode-unknown"));
    assert.equal(incomplete.work_lane_fresh_total, "unknown");
    assert.ok(incomplete.gaps.some((gap) => gap.name === "admission-records-incomplete"));
    assert.equal(incomplete.peak_runtime_native_concurrency, "unknown");
    assert.equal(incomplete.child_round_trips, "unknown");
    assert.equal(incomplete.continue_ratio, "unknown");

    const zeroSpawn = deriveDelegationTelemetry({ descendants: [], externals: [], admissionRecords: { available: true, records: [], malformed: 0 }, spawnObservable: true });
    assert.equal(zeroSpawn.work_lane_fresh_total, 0);
    assert.equal(zeroSpawn.peak_runtime_native_concurrency, 0);
    assert.equal(zeroSpawn.child_round_trips, 0);
    assert.equal(zeroSpawn.continue_ratio, "unknown");

    const unobservedZero = deriveDelegationTelemetry({ descendants: [], externals: [], admissionRecords: { available: false, reason: "x" }, spawnObservable: false });
    assert.equal(unobservedZero.peak_runtime_native_concurrency, "unknown");
    assert.equal(unobservedZero.child_round_trips, "unknown");
  });

  it("buildLineageUsageReport exposes the delegation block and the renderer prints the eight-field summary without `?? 0`", () => {
    const sessions = [
      { host: "claude-code", session_id: parentId, usage: { input: 10, output: 5, cache_read: 1, cache_creation: 1 }, terminality: "open" },
      { host: "claude-code", session_id: childA, usage: { input: 4, output: 2, cache_read: 1, cache_creation: 1 }, terminality: "open", context_mode: "fresh", delegation_evidence: evidence({ dispatch_turns: 2 }) },
    ];
    const adapter = {
      enumerateMetadata: () => ({
        nodes: [sessions[1]],
        edges: [{ parent_identity: `claude-code:${parentId}`, child_identity: `claude-code:${childA}`, evidence_digest: "edge-x" }],
        spawn_events: 1,
        spawn_observability: "complete",
      }),
      readSessionUsage: ({ session_id }) => {
        const found = sessions.find((session) => session.session_id === session_id);
        return { available: true, totals: found.usage, cost_usd: null, terminality: found.terminality, field_availability: {}, gaps: [] };
      },
    };
    const report = buildLineageUsageReport({
      roots: [sessions[0]],
      hostAdapters: { "claude-code": adapter },
      admissionRecords: { available: false, reason: "admission-records-dir-missing" },
    });
    assert.equal(report.delegation.child_round_trips, 2);
    assert.equal(report.delegation.continue_ratio, 0.5);
    assert.equal(report.delegation.work_lane_fresh_total, "unknown");
    assert.equal(report.counts.descendant_sessions, 1);
    const markdown = renderLineageSummaryMarkdown(report);
    assert.match(markdown, /- work_lane_fresh_total: unknown/);
    assert.match(markdown, /- peak_runtime_native_concurrency: 1/);
    assert.match(markdown, /- child_round_trips: 2/);
    assert.match(markdown, /- continue_ratio: 0\.5/);
    assert.match(markdown, /- policy_mode: fresh=1,continue=1,fork=0,external=0,unknown=0/);
    const source = readFileSync(path.join(here, "../lib/session-usage-lineage.mjs"), "utf8");
    const start = source.indexOf("export function deriveDelegationTelemetry");
    const end = source.indexOf("\nexport function", start + 1);
    assert.ok(start > 0 && end > start);
    assert.equal(source.slice(start, end).includes("?? 0"), false, "new-field path must not coerce missing evidence to 0");
  });
});

describe("T29 Codex continuation evidence (fixture codex-continuation-followup-task.json)", () => {
  const fixture = JSON.parse(readFileSync(path.join(here, "fixtures", "session-usage-lineage", "codex-continuation-followup-task.json"), "utf8"));
  const stamp = (records, base) => records.map((record, index) => ({ timestamp: new Date(Date.parse(base) + index * 1000).toISOString(), ...record }));
  const parentContent = stamp(fixture.parent_rollout, "2026-01-01T00:00:00Z").map((r) => JSON.stringify(r)).join("\n");
  const childContent = stamp(fixture.child_rollout, "2026-01-01T00:00:30Z").map((r) => JSON.stringify(r)).join("\n");

  it("parseCodexRollout joins spawn_agent arguments to the child agent_path and counts followup_task calls", () => {
    const parent = parseCodexRollout(parentContent);
    assert.equal(parent.spawn_events, 1);
    assert.deepEqual(parent.spawn_dispatches, [
      { agent_type: "dp-probe-preload", fork_turns: "none", fork_context: null, agent_path: "/root/t27_codex_preload_and_continuation_probe" },
    ]);
    assert.equal(parent.continuation_events, 1);
    assert.equal(parent.turn_boundaries.dispatch_turns, 1);
  });

  it("parseCodexRollout reports the child's task_started boundaries as dispatch turns (2 turns → 1 continuation)", () => {
    const child = parseCodexRollout(childContent);
    assert.equal(child.turn_boundaries.dispatch_turns, 2);
    assert.equal(child.turn_boundaries.start_ts, "2026-01-01T00:00:31.000Z");
    assert.ok(typeof child.turn_boundaries.end_ts === "string");
    assert.equal(child.spawn_dispatches.length, 0);
    assert.equal(child.continuation_events, 0);
  });

  it("parseCodexRollout leaves turn_boundaries null without task_started records (fallback mode)", () => {
    const parsed = parseCodexRollout(JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } } }));
    assert.equal(parsed.turn_boundaries, null);
  });

  it("enumerateCodexLineageMetadata carries the child's thread_spawn carrier as spawn_carrier metadata only", () => {
    const rootId = "51515151-5151-4151-8151-515151515151";
    const childId = "52525252-5252-4252-8252-525252525252";
    const sub = (text) => text.replaceAll("<parent-id>", rootId).replaceAll("<child-id>", childId);
    const root = path.join(path.parse(process.cwd()).root, "codex");
    const sessionDir = path.join(root, "sessions");
    const dayDir = path.join(sessionDir, "2026", "01", "01");
    const rootFile = path.join(dayDir, `rollout-2026-01-01T00-00-00-${rootId}.jsonl`);
    const childFile = path.join(dayDir, `rollout-2026-01-01T00-00-30-${childId}.jsonl`);
    const files = new Map([[rootFile, sub(parentContent)], [childFile, sub(childContent)]]);
    const indexed = enumerateCodexLineageMetadata({
      root,
      rootSessionId: rootId,
      listDir: (dir) => {
        if (dir === sessionDir) return ["2026"];
        if (dir === path.join(sessionDir, "2026")) return ["01"];
        if (dir === path.join(sessionDir, "2026", "01")) return ["01"];
        if (dir === dayDir) return [path.basename(rootFile), path.basename(childFile)];
        return [];
      },
      readPrefix: (file) => files.get(file) ?? "",
    });
    const child = indexed.nodes.find((node) => node.session_id === childId);
    assert.deepEqual(child.spawn_carrier, { agent_role: "dp-probe-preload", agent_path: "/root/t27_codex_preload_and_continuation_probe", depth: 1 });
    assert.equal(indexed.nodes.find((node) => node.session_id === rootId).spawn_carrier, undefined);
    assert.equal(indexed.edges.length, 1);
    assert.equal(indexed.edges[0].parent_identity, `codex:${rootId}`);
    assert.equal(Object.hasOwn(child.spawn_carrier, "agent_nickname"), false);
  });

  it("deriveCodexDescendantEvidence maps fork_turns none → fresh with continuation_turns from the child boundaries", () => {
    const parentActivity = parseCodexRollout(parentContent);
    const activity = parseCodexRollout(childContent);
    const derived = deriveCodexDescendantEvidence({
      spawnCarrier: { agent_role: "dp-probe-preload", agent_path: "/root/t27_codex_preload_and_continuation_probe", depth: 1 },
      activity,
      parentActivity,
    });
    assert.equal(derived.context_mode, "fresh");
    assert.deepEqual(derived.gaps, []);
    assert.equal(derived.delegation_evidence.agent_type, "dp-probe-preload");
    assert.equal(derived.delegation_evidence.spawn_depth, 1);
    assert.equal(derived.delegation_evidence.dispatch_turns, 2);
    assert.equal(derived.delegation_evidence.prompt_sha256, null);
    const telemetry = deriveDelegationTelemetry({
      descendants: [{ identity: "codex:child", context_mode: derived.context_mode, delegation_evidence: derived.delegation_evidence, delegation_gaps: derived.gaps }],
      admissionRecords: { available: false, reason: "admission-records-dir-missing" },
      spawnObservable: true,
    });
    const row = telemetry.per_contributor[0];
    assert.equal(row.policy_mode, "fresh");
    assert.equal(row.continuation_turns, 1);
    assert.equal(telemetry.child_round_trips, 2);
    assert.equal(telemetry.policy_mode_counts.continue, 1);
    assert.equal(telemetry.gaps.some((gap) => gap.name === "codex-continuation-unverified"), false);
  });

  it("deriveCodexDescendantEvidence maps fork_turns all / integers and legacy fork_context to fork, depth ≥ 2 to nested", () => {
    const carrier = { agent_role: "dp-explorer", agent_path: "/root/x", depth: 1 };
    const activity = { turn_boundaries: { dispatch_turns: 1, start_ts: "2026-01-01T00:00:00Z", end_ts: "2026-01-01T00:00:01Z" } };
    for (const dispatch of [{ fork_turns: "all" }, { fork_turns: "3" }, { fork_turns: null, fork_context: true }]) {
      const derived = deriveCodexDescendantEvidence({ spawnCarrier: carrier, activity, parentActivity: { spawn_dispatches: [{ agent_path: "/root/x", agent_type: "dp-explorer", fork_context: null, ...dispatch }] } });
      assert.equal(derived.context_mode, "fork", JSON.stringify(dispatch));
    }
    const fresh = deriveCodexDescendantEvidence({ spawnCarrier: carrier, activity, parentActivity: { spawn_dispatches: [{ agent_path: "/root/x", agent_type: "dp-explorer", fork_turns: null, fork_context: false }] } });
    assert.equal(fresh.context_mode, "fresh");
    const nested = deriveCodexDescendantEvidence({ spawnCarrier: { ...carrier, depth: 2 }, activity, parentActivity: { spawn_dispatches: [] } });
    assert.equal(nested.context_mode, "nested");
    assert.equal(nested.delegation_evidence.spawn_depth, 2);
  });

  it("deriveCodexDescendantEvidence never infers: missing boundaries → codex-continuation-unverified, unjoinable or ambiguous dispatch → codex-context-mode-unknown", () => {
    const carrier = { agent_role: "dp-explorer", agent_path: "/root/x", depth: 1 };
    const noBoundaries = deriveCodexDescendantEvidence({ spawnCarrier: carrier, activity: { turn_boundaries: null }, parentActivity: { spawn_dispatches: [{ agent_path: "/root/x", fork_turns: "none" }] } });
    assert.equal(noBoundaries.delegation_evidence.dispatch_turns, null);
    assert.deepEqual(noBoundaries.gaps, [{ name: "codex-continuation-unverified" }]);
    const unjoined = deriveCodexDescendantEvidence({ spawnCarrier: carrier, activity: { turn_boundaries: { dispatch_turns: 1 } }, parentActivity: { spawn_dispatches: [{ agent_path: "/root/other", fork_turns: "none" }] } });
    assert.equal(unjoined.context_mode, null);
    assert.deepEqual(unjoined.gaps, [{ name: "codex-context-mode-unknown" }]);
    const omitted = deriveCodexDescendantEvidence({ spawnCarrier: carrier, activity: { turn_boundaries: { dispatch_turns: 1 } }, parentActivity: { spawn_dispatches: [{ agent_path: "/root/x", fork_turns: null, fork_context: null }] } });
    assert.equal(omitted.context_mode, null, "omitted fork_turns is not assumed to be fresh or fork");
    const ambiguous = deriveCodexDescendantEvidence({ spawnCarrier: carrier, activity: { turn_boundaries: { dispatch_turns: 1 } }, parentActivity: { spawn_dispatches: [{ agent_path: "/root/x", fork_turns: "none" }, { agent_path: "/root/x", fork_turns: "all" }] } });
    assert.equal(ambiguous.context_mode, null);
    const noParent = deriveCodexDescendantEvidence({ spawnCarrier: carrier, activity: undefined, parentActivity: undefined });
    assert.deepEqual(noParent.gaps.map((gap) => gap.name), ["codex-continuation-unverified", "codex-context-mode-unknown"]);
    const telemetry = deriveDelegationTelemetry({
      descendants: [{ identity: "codex:child", context_mode: null, delegation_evidence: noParent.delegation_evidence, delegation_gaps: noParent.gaps }],
      admissionRecords: { available: false, reason: "not-provided" },
      spawnObservable: true,
    });
    assert.deepEqual(telemetry.gaps.filter((gap) => gap.identity === "codex:child").map((gap) => gap.name), ["codex-continuation-unverified", "codex-context-mode-unknown", "policy-mode-unknown"]);
    assert.equal(telemetry.per_contributor[0].continuation_turns, null);
    assert.equal(telemetry.child_round_trips, "unknown");
  });
});
