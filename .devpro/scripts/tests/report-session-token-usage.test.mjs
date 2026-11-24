import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  sanitizeItem,
  ensureHostRoot,
  matchesCwdRoots,
  collapseTerminalMessagesById,
  asMessageArray,
  parseClaudeCodeTurns,
  extractCostState,
  parseSubagentTranscript,
  loadClaudeCodeSubagents,
  readClaudeCodeSession,
  readCodexSession,
  MAX_TRANSCRIPT_BYTES,
  resolveCodexSessionId,
  parseCodexTokenCountEvents,
  parseCodexRollout,
  parseJsonl,
  parseCodexJsonl,
  renderMarkdownLedger,
  TABLE_HEADER,
  classifyTurnOrigin,
  groupTurnsByClass,
  unionCheckpointMeasurementSessions,
  aggregateSinceChangeUsage,
} from "../lib/session-token-usage.mjs";
import { main as reportCliMain, resolveCwdRoots } from "../report-session-token-usage.mjs";
import { discoverUsageManifests, USAGE_MANIFEST_SCHEMA, writeUsageManifest } from "../lib/session-usage-manifest.mjs";
import {
  cleanupOwnedControlEvidence,
  claimDispatchInvocation,
  COMPLETION_SCHEMA,
  reserveDispatchRecord,
  writeCompletionReceipt,
  COMPLETE_CHAIN_OWNER_TTL_MS,
} from "../hooks/lib/second-review-control-evidence.mjs";
import { digestEvidenceBoundary } from "../lib/session-usage-lineage.mjs";
import { hasTokenSpendRecord } from "../recap-body-template-check.mjs";
import {
  appendChangeUsageSession,
  appendChangeUsageOverride,
  changeUsageCheckpointPath,
  recordSessionChangeTransition,
} from "../hooks/lib/change-usage-checkpoint.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { deriveEffectiveBudgetState } from "../lib/cost-budget.mjs";

// ---------------------------------------------------------------------------
// Test-local, hand-written GFM helpers (D7 / T1 last bullet): MUST NOT reuse
// sanitizeItem's own regex/replace table. Independent, deliberately naive.
// ---------------------------------------------------------------------------

/** Naive GFM row split: literal `|` IS the delimiter, no backslash/code-span
 * awareness (sanitizeItem never emits backslash escapes, so this is the
 * correct independent check — see design.md D7 round-3 note). */
function testSplitGfmTableRow(line) {
  const trimmed = line.trim();
  const withoutFences = trimmed.replace(/^\|/u, "").replace(/\|$/u, "");
  return withoutFences.split("|");
}

/** Independent GFM extended-autolink / mention detector (hand-written from
 * spec, not from sanitizeItem's encode table). */
function testDetectBareLinkOrMention(text) {
  const patterns = [
    /https?:\/\/[^\s<>]+/iu,
    /(?<![\w@.])www\.[^\s<>]+/iu,
    /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/u,
    /(?:^|[^\w])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?/u,
  ];
  return patterns.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// F-I9(b): real `type:"user"` records for a genuine typed prompt carry
// `message.content` as a plain STRING (F-C2) — arrays only occur for
// `tool_result` content (see toolResultRecord below). This fixture builder
// now matches that real shape so tests exercise the same code path real
// transcripts do.
function userRecord({ id, ts, cwd = "/repo", text, uuid, parentUuid = null }) {
  return { type: "user", timestamp: ts, cwd, uuid, parentUuid, message: { id, role: "user", content: text } };
}

// D9 / task 15: a `type:"system"` transcript record (compact_boundary,
// scheduled_task_fire, stop_hook_summary, turn_duration, away_summary,
// local_command) — the marker family `classifyTurnOrigin` walks
// `parentUuid` back through.
function systemRecord({ uuid, parentUuid = null, subtype, ts = "t0" }) {
  return { type: "system", subtype, timestamp: ts, uuid, parentUuid };
}

// A non-system STOP endpoint for a `parentUuid` walk — shape-minimal, only
// `type`/`uuid` matter to classifyTurnOrigin.
function attachmentRecord({ uuid }) {
  return { type: "attachment", uuid };
}

function toolResultRecord({ id, ts, cwd = "/repo" }) {
  return {
    type: "user",
    timestamp: ts,
    cwd,
    message: { id, role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
  };
}

// The in-memory host doubles accept host-native paths from production code
// while keeping fixture declarations readable on POSIX. Normalize only the
// lookup key so a Windows `path.join()` uses the same virtual entry.
function fixturePathValue(table, candidatePath) {
  if (Object.hasOwn(table, candidatePath)) return table[candidatePath];
  const normalized = path.normalize(candidatePath);
  const match = Object.entries(table).find(([fixturePath]) => path.normalize(fixturePath) === normalized);
  return match?.[1];
}

function fixturePathRequired(table, candidatePath) {
  const value = fixturePathValue(table, candidatePath);
  if (value === undefined) throw new Error(`ENOENT ${candidatePath}`);
  return value;
}

function assistantRecord({
  id,
  ts,
  stop_reason = "end_turn",
  model = "claude-opus-4",
  output_tokens = 0,
  input_tokens = 0,
  cache_read_input_tokens = 0,
  cache_creation_input_tokens = 0,
  toolUseId = null,
}) {
  const content = [];
  if (toolUseId) content.push({ type: "tool_use", id: toolUseId });
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      id,
      role: "assistant",
      model,
      stop_reason,
      content,
      usage: { output_tokens, input_tokens, cache_read_input_tokens, cache_creation_input_tokens },
    },
  };
}

function costStateRecord({ totalCostUSD, modelUsage, hasUnknownModelCost = false }) {
  return { type: "cost-state", totalCostUSD, modelUsage, hasUnknownModelCost };
}

// F-I9(a) / F-C1b: real Codex token-usage records are `event_msg` envelopes —
// `{ type: "event_msg", payload: { type: "token_count", info: {...} } }` —
// NOT a flat `{ type: "token_count", info: {...} }` record. `item` has no
// real-world counterpart on this payload (Codex usage events carry no
// prompt-text correlation); it is kept here purely as a fixture-only label so
// tests can identify which turn produced which row.
function tokenCountEvent({
  ts,
  item = "",
  input_tokens,
  cached_input_tokens,
  output_tokens,
  reasoning_output_tokens = 0,
  cache_write_input_tokens = 0,
  total_tokens,
  totalTokenUsage = null,
}) {
  const last_token_usage = {
    input_tokens,
    cached_input_tokens,
    output_tokens,
    reasoning_output_tokens,
    cache_write_input_tokens,
    total_tokens: total_tokens ?? input_tokens + output_tokens,
  };
  const info = { last_token_usage };
  if (totalTokenUsage) info.total_token_usage = totalTokenUsage;
  return { type: "event_msg", timestamp: ts, payload: { type: "token_count", item, info } };
}

function tokenUsageRecordEvent({ ts, threadId, responseId, turnId, usage, threadTokenUsage, turnTokenUsage = usage }) {
  return {
    type: "token_usage_record",
    timestamp: ts,
    ordinal: 1,
    payload: {
      thread_id: threadId,
      turn_id: turnId,
      session_id: threadId,
      root_turn_id: turnId,
      response_id: responseId,
      usage,
      turn_token_usage: turnTokenUsage,
      thread_token_usage: threadTokenUsage,
    },
  };
}

// F-I9(a): real Codex `session_meta` records nest session id/cwd under
// `payload` — `{ type: "session_meta", payload: { id, cwd, ... } }` — NOT at
// the record's top level.
function sessionMetaRecord({ sessionId, cwd, ts }) {
  return { type: "session_meta", timestamp: ts, payload: { id: sessionId, cwd } };
}

function taskStartedEvent({ turnId, ts = "t0" }) {
  return { type: "event_msg", timestamp: ts, payload: { type: "task_started", turn_id: turnId, started_at: 1 } };
}

function taskCompleteEvent({ turnId, ts = "t1", durationMs = 1200 }) {
  return {
    type: "event_msg",
    timestamp: ts,
    payload: { type: "task_complete", turn_id: turnId, duration_ms: durationMs, started_at: 1, completed_at: 2 },
  };
}

function codexUserMessage({ ts = "t0", text }) {
  return {
    type: "response_item",
    timestamp: ts,
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

function codexUserMessageEvent({ ts = "t0", text }) {
  return {
    type: "event_msg",
    timestamp: ts,
    payload: { type: "user_message", message: text },
  };
}

function spawnAgentCall({ ts = "t0", agentType }) {
  return {
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      arguments: JSON.stringify({ agent_type: agentType, message: "go" }),
    },
  };
}

/** In-memory Claude Code host double: no real filesystem, no mkdtempSync. */
function buildClaudeCodeFixture({ sessionId, records, subagents = [], projectDir = "proj" }) {
  const root = "/claude-root";
  const mainPath = `${root}/projects/${projectDir}/${sessionId}.jsonl`;
  const content = records.map((r) => JSON.stringify(r)).join("\n");
  const files = { [mainPath]: content };
  const dirs = {
    [root]: ["projects"],
    [`${root}/projects`]: [projectDir],
    [`${root}/projects/${projectDir}`]: [`${sessionId}.jsonl`],
  };
  if (subagents.length > 0) {
    const subDir = `${root}/projects/${projectDir}/${sessionId}/subagents`;
    dirs[subDir] = subagents.map((s) => s.id);
    for (const s of subagents) {
      const base = `${subDir}/${s.id}`;
      files[`${base}/meta.json`] = JSON.stringify(s.meta);
      files[`${base}/transcript.jsonl`] = s.records.map((r) => JSON.stringify(r)).join("\n");
    }
  }
  const listDir = (p) => {
    return fixturePathRequired(dirs, p);
  };
  const readFile = (p) => {
    return fixturePathRequired(files, p);
  };
  return { root, listDir, readFile, realpath: (p) => p };
}

/** In-memory Codex host double. F-I9(a): real Codex rollout files live under
 * a nested `sessions/<YYYY>/<MM>/<DD>/*.jsonl` layout (F-C1), not a flat
 * `sessions/*.jsonl` dir — this fixture mirrors that nesting so T5/T6 exercise
 * the same directory-walk code path real sessions do. */
function buildCodexFixture({ files: extraFiles = {}, filenames }) {
  const root = "/codex-root";
  const datePath = "2026/01/01";
  const dirs = {
    [root]: ["sessions"],
    [`${root}/sessions`]: ["2026"],
    [`${root}/sessions/2026`]: ["01"],
    [`${root}/sessions/2026/01`]: ["01"],
    [`${root}/sessions/${datePath}`]: Object.keys(filenames),
  };
  const files = {};
  for (const [filename, records] of Object.entries(filenames)) {
    files[`${root}/sessions/${datePath}/${filename}`] = records.map((r) => JSON.stringify(r)).join("\n");
  }
  Object.assign(files, extraFiles);
  const listDir = (p) => {
    return fixturePathRequired(dirs, p);
  };
  const readFile = (p) => {
    return fixturePathRequired(files, p);
  };
  return { root, listDir, readFile, realpath: (p) => p };
}

// ===========================================================================
// T1 — sanitizeItem
// ===========================================================================

describe("T1 sanitizeItem", () => {
  it("returns { available: false, reason } when host root does not exist", () => {
    const result = ensureHostRoot({
      root: "/nope",
      listDir: () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(result.available, false);
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  });

  it("replaces home dir prefix and url-encoded cwd", () => {
    const homeDir = "/Users/allenchan";
    assert.equal(sanitizeItem("/Users/allenchan/foo/bar", { homeDir }), "~/foo/bar");
    assert.equal(
      sanitizeItem("-Users-allenchan-myrepo prefix", { homeDir }),
      "<enc-cwd>/myrepo prefix",
    );
  });

  it("adversarial: table pipe", () => {
    assert.equal(sanitizeItem("a|b", {}), "a&#124;b");
  });

  it("adversarial: backslash + pipe combination is unaffected by backslash parity", () => {
    assert.equal(sanitizeItem("a\\|b", {}), "a\\&#124;b");
  });

  it("adversarial: literal &#124; string is not re-parsed into an active pipe", () => {
    assert.equal(sanitizeItem("&#124;", {}), "&amp;#124;");
  });

  it("adversarial: literal &lt; string is not re-parsed into an active <", () => {
    assert.equal(sanitizeItem("&lt;", {}), "&amp;lt;");
  });

  it("adversarial: newline collapses to a single space", () => {
    assert.equal(sanitizeItem("a\nb", {}), "a b");
  });

  it("adversarial: script tag leaves no bare <", () => {
    const out = sanitizeItem("<script>alert(1)</script>", {});
    assert.equal(out, "&lt;script>alert(1)&lt;/script>");
    assert.ok(!out.includes("<"));
  });

  it("adversarial: bare URL defeats scheme autolink", () => {
    assert.equal(sanitizeItem("http://example.com", {}), "http&#58;//example&#46;com");
  });

  it("adversarial: www. prefix defeats www autolink", () => {
    assert.equal(sanitizeItem("www.example.com", {}), "www&#46;example.com");
  });

  it("adversarial: email-style string defeats email autolink via @ encoding alone", () => {
    assert.equal(sanitizeItem("user@example.com", {}), "user&#64;example.com");
  });

  it("adversarial: @mention", () => {
    assert.equal(sanitizeItem("@some-user", {}), "&#64;some-user");
  });

  it("adversarial: #issue-ref", () => {
    assert.equal(sanitizeItem("#1234", {}), "&#35;1234");
  });

  it("adversarial: code-span literal pipe is still encoded (GFM row-split precedes code-span parsing)", () => {
    assert.equal(sanitizeItem("`a|b`", {}), "`a&#124;b`");
  });

  it("adversarial: bidi control character is removed and placeholder-ed", () => {
    assert.equal(sanitizeItem("a\u202Eb", {}), "a<ctrl>b");
  });

  it("F-C3: pre-existing ENC_CWD_OPEN/CLOSE sentinel codepoints in the INPUT do not bypass escaping (sentinel sanitizer bug)", () => {
    // U+E000 / U+E001 are the private-use sentinels sanitizeItem uses
    // internally to protect the system-inserted <enc-cwd> placeholder from
    // being escaped by encodeActiveCharacters. If the RAW input already
    // contains these codepoints (attacker/user-supplied, not
    // system-inserted), they must be stripped before any other processing \u2014
    // otherwise the final unconditional sentinel->literal-bracket replace
    // step turns them into unescaped `<`/`>`, defeating the whole mechanism.
    const attack = "\uE000script\uE001alert(1)\uE000/script\uE001";
    const out = sanitizeItem(attack, {});
    assert.ok(!out.includes("<"), `expected zero bare < in output, got: ${JSON.stringify(out)}`);
    assert.ok(!out.includes(">"), `expected zero bare > in output, got: ${JSON.stringify(out)}`);
  });

  it("F-C3: a real <enc-cwd> placeholder still renders as literal angle brackets (sentinel fix must not break the legitimate system-inserted case)", () => {
    const homeDir = "/Users/allenchan";
    assert.equal(
      sanitizeItem("-Users-allenchan-myrepo prefix", { homeDir }),
      "<enc-cwd>/myrepo prefix",
    );
  });

  it("combined adversarial fixture renders to exactly 8 GFM columns with zero bare-link/mention hits and no bare <", () => {
    const parts = [
      "a|b",
      "a\\|b",
      "&#124;",
      "&lt;",
      "line1\nline2",
      "<script>alert(1)</script>",
      "http://example.com",
      "www.example.com",
      "user@example.com",
      "@some-user",
      "#1234",
      "`a|b`",
    ];
    const composite = parts.join(" :: ");
    const sanitized = sanitizeItem(composite, { itemWidth: 2000 });

    assert.ok(!sanitized.includes("<"), "no bare < should survive in a fixture with no bidi/control input");

    const row = `| a | b | c | ${sanitized} | e | f | g | h |`;
    const columns = testSplitGfmTableRow(row);
    assert.equal(columns.length, 8, `expected 8 columns, got ${columns.length}: ${JSON.stringify(columns)}`);

    assert.equal(testDetectBareLinkOrMention(sanitized), false);
  });

  it("truncation happens before escaping — cutting exactly on a table separator produces no half-escaped reference", () => {
    const out = sanitizeItem("AB|CD", { itemWidth: 3 });
    assert.equal(out, "AB&#124;…");
    // A severed reference looks like "&#12" with no closing ";" (e.g. the tail end
    // of a truncated "&#124;"); every "&#" in a correctly-ordered result is
    // followed by digits and a semicolon, so this must find zero matches.
    assert.equal(/&#(?!\d+;)/u.test(out), false, "must not contain a severed character reference");
  });

  it("truncation counts RAW pre-& characters, not the post-&-normalization expansion", () => {
    // "XY&amp;Z" is 8 raw characters: X,Y,&,a,m,p,;,Z. itemWidth=4 lands mid the
    // literal "&amp;" the user typed (after X,Y,&,a). Correct order (sanitize ->
    // truncate -> & normalize -> refs) truncates the RAW '&' at position 2 into
    // the 4-char window, and step 3 then escapes that lone '&' into "&amp;" —
    // giving "XY&amp;a…". A wrong order (normalize-then-truncate) would instead
    // truncate the already-expanded "XY&amp;amp;Z" string to "XY&a…", which is
    // a visibly different (and still-unescaped-&) result.
    const out = sanitizeItem("XY&amp;Z", { itemWidth: 4 });
    assert.equal(out, "XY&amp;a…");
  });

  it("test-local GFM row-splitter and link/mention detector are independent of sanitizeItem's own encode table", () => {
    // Sanity check the test helpers themselves against known-safe input, proving
    // they are self-contained functions (no shared regex table with sanitizeItem).
    assert.deepEqual(testSplitGfmTableRow("| a | b | c |"), [" a ", " b ", " c "]);
    assert.equal(testDetectBareLinkOrMention("plain text, no links"), false);
    assert.equal(testDetectBareLinkOrMention("visit http://example.com now"), true);
    assert.equal(testDetectBareLinkOrMention("say hi to @someone"), true);
  });
});

// ===========================================================================
// T2 — Claude Code turn splitting + dedup
// ===========================================================================

describe("T2 Claude Code turn splitting", () => {
  it("tool_result backfill does not start a new turn; duplicate message.id counts once", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "do the thing" }),
      assistantRecord({ id: "m1", ts: "t1", output_tokens: 5, input_tokens: 10 }),
      assistantRecord({ id: "m1", ts: "t1", output_tokens: 5, input_tokens: 10 }), // exact duplicate
      toolResultRecord({ id: "u2", ts: "t2" }),
      assistantRecord({ id: "m2", ts: "t3", output_tokens: 1, input_tokens: 1 }),
    ];
    const turns = parseClaudeCodeTurns(records);
    assert.equal(turns.length, 1, "tool_result backfill must not start a new turn");
    assert.equal(turns[0].tokens.output, 6, "m1 must be counted once, plus m2");
  });

  it("F-C2: a genuine typed prompt's plain-string message.content populates 項目 (real shape, not the array-only fixture shape)", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "找回剛剛的對話\nand second line" }),
      assistantRecord({ id: "m1", ts: "t1", output_tokens: 1 }),
    ];
    const turns = parseClaudeCodeTurns(records);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].item, "找回剛剛的對話", "item must be the first LINE of the real string content");
  });

  it("F-C2: array content with a mixed tool_result + text block still yields the text block's first line (unchanged branch)", () => {
    const records = [
      {
        type: "user",
        timestamp: "t0",
        cwd: "/repo",
        message: {
          id: "u1",
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: "ok" },
            { type: "text", text: "follow-up prompt" },
          ],
        },
      },
      assistantRecord({ id: "m1", ts: "t1", output_tokens: 1 }),
    ];
    const turns = parseClaudeCodeTurns(records);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].item, "follow-up prompt");
  });
});

// ===========================================================================
// D9 / task 15 — classifyTurnOrigin: --by-class main-context origin
// classification. Real-transcript evidence (task 15 decisions section):
// walking `parentUuid` back through `type:"system"` records reliably hits
// compact_boundary (zero-hop, 75/75 in the sample session),
// scheduled_task_fire (zero-hop, 18/18), and stop_hook_summary (via
// turn_duration/away_summary/local_command passthrough, 160/193 — the
// remaining 33 never precede a later turn, which is not a misclassification).
// Every fall-through arm below MUST be exercised because real transcripts
// never produced an `unsupported` case — only synthetic fixtures prove the
// bucket isn't silently absorbed into `user` (advisor-flagged gap in the
// first draft, which collapsed all three fail-closed arms into `user`).
// ===========================================================================

describe("D9 classifyTurnOrigin", () => {
  it("no parentUuid at all -> user (session/turn sequence start, not data loss)", () => {
    assert.equal(classifyTurnOrigin(null, new Map()), "user");
    assert.equal(classifyTurnOrigin(undefined, new Map()), "user");
  });

  it("parentUuid points directly at a non-system record -> user (clean STOP, zero-hop)", () => {
    const byUuid = new Map([["a1", attachmentRecord({ uuid: "a1" })]]);
    assert.equal(classifyTurnOrigin("a1", byUuid), "user");
  });

  it("zero-hop compact_boundary -> compaction-continuation", () => {
    const byUuid = new Map([["c1", systemRecord({ uuid: "c1", subtype: "compact_boundary" })]]);
    assert.equal(classifyTurnOrigin("c1", byUuid), "compaction-continuation");
  });

  it("zero-hop scheduled_task_fire -> wakeup", () => {
    const byUuid = new Map([["w1", systemRecord({ uuid: "w1", subtype: "scheduled_task_fire" })]]);
    assert.equal(classifyTurnOrigin("w1", byUuid), "wakeup");
  });

  it("turn_duration -> stop_hook_summary passthrough chain -> stop-hook (most common real pattern, 144/193)", () => {
    const byUuid = new Map([
      ["td1", systemRecord({ uuid: "td1", subtype: "turn_duration", parentUuid: "sh1" })],
      ["sh1", systemRecord({ uuid: "sh1", subtype: "stop_hook_summary", parentUuid: "att1" })],
      ["att1", attachmentRecord({ uuid: "att1" })],
    ]);
    assert.equal(classifyTurnOrigin("td1", byUuid), "stop-hook");
  });

  it("nearest marker wins: scheduled_task_fire -> wakeup even when an earlier stop_hook_summary sits further back in the same chain", () => {
    const byUuid = new Map([
      ["w1", systemRecord({ uuid: "w1", subtype: "scheduled_task_fire", parentUuid: "td1" })],
      ["td1", systemRecord({ uuid: "td1", subtype: "turn_duration", parentUuid: "sh1" })],
      ["sh1", systemRecord({ uuid: "sh1", subtype: "stop_hook_summary", parentUuid: "att1" })],
      ["att1", attachmentRecord({ uuid: "att1" })],
    ]);
    assert.equal(classifyTurnOrigin("w1", byUuid), "wakeup");
  });

  it("away_summary -> turn_duration -> stop_hook_summary two-hop passthrough -> stop-hook", () => {
    const byUuid = new Map([
      ["as1", systemRecord({ uuid: "as1", subtype: "away_summary", parentUuid: "td1" })],
      ["td1", systemRecord({ uuid: "td1", subtype: "turn_duration", parentUuid: "sh1" })],
      ["sh1", systemRecord({ uuid: "sh1", subtype: "stop_hook_summary", parentUuid: "att1" })],
      ["att1", attachmentRecord({ uuid: "att1" })],
    ]);
    assert.equal(classifyTurnOrigin("as1", byUuid), "stop-hook");
  });

  it("local_command is an allowlisted passthrough subtype", () => {
    const byUuid = new Map([
      ["lc1", systemRecord({ uuid: "lc1", subtype: "local_command", parentUuid: "lc2" })],
      ["lc2", systemRecord({ uuid: "lc2", subtype: "local_command", parentUuid: "sh1" })],
      ["sh1", systemRecord({ uuid: "sh1", subtype: "stop_hook_summary", parentUuid: "att1" })],
      ["att1", attachmentRecord({ uuid: "att1" })],
    ]);
    assert.equal(classifyTurnOrigin("lc1", byUuid), "stop-hook");
  });

  it("dangling parentUuid (chain breaks — no matching record in the index) -> unsupported, NOT user", () => {
    assert.equal(classifyTurnOrigin("missing-uuid", new Map()), "unsupported");
  });

  it("unknown/future system subtype -> unsupported, NOT silently treated as passthrough or user", () => {
    const byUuid = new Map([["f1", systemRecord({ uuid: "f1", subtype: "some_future_marker", parentUuid: "att1" })]]);
    assert.equal(classifyTurnOrigin("f1", byUuid), "unsupported");
  });

  it("passthrough chain dead-ends (a passthrough system record has no parentUuid of its own) -> unsupported", () => {
    const byUuid = new Map([["td1", systemRecord({ uuid: "td1", subtype: "turn_duration", parentUuid: null })]]);
    assert.equal(classifyTurnOrigin("td1", byUuid), "unsupported");
  });

  it("hop budget exhausted (chain of passthrough nodes longer than the internal bound) -> unsupported, NOT user", () => {
    const byUuid = new Map();
    const chainLength = 12; // exceeds the internal bound (longest real chain observed: 4 hops)
    for (let i = 0; i < chainLength; i += 1) {
      byUuid.set(
        `td${i}`,
        systemRecord({ uuid: `td${i}`, subtype: "turn_duration", parentUuid: i + 1 < chainLength ? `td${i + 1}` : "att1" }),
      );
    }
    byUuid.set("att1", attachmentRecord({ uuid: "att1" }));
    assert.equal(classifyTurnOrigin("td0", byUuid), "unsupported");
  });
});

describe("D9 parseClaudeCodeTurns origin_class integration", () => {
  it("turn-start user record with no parentUuid classifies as user", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "hi", uuid: "u1" }),
      assistantRecord({ id: "m1", ts: "t1", output_tokens: 1 }),
    ];
    const turns = parseClaudeCodeTurns(records);
    assert.equal(turns[0].origin_class, "user");
  });

  it("turn-start user record whose parentUuid resolves through the transcript's own system records to compact_boundary classifies as compaction-continuation", () => {
    const records = [
      systemRecord({ uuid: "cb1", subtype: "compact_boundary", ts: "t0" }),
      userRecord({ id: "u1", ts: "t1", text: "continue", uuid: "u1", parentUuid: "cb1" }),
      assistantRecord({ id: "m1", ts: "t2", output_tokens: 1 }),
    ];
    const turns = parseClaudeCodeTurns(records);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].origin_class, "compaction-continuation");
  });
});

describe("D9 groupTurnsByClass: --by-class grouping", () => {
  it("groups main turns by origin_class and subagent turns by subagent:<type>, keeping counts and tokens separate (acceptance: user + subagent:<type> grouped correctly)", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "hi", uuid: "u1" }),
      assistantRecord({ id: "m1", ts: "t1", output_tokens: 10, toolUseId: "toolu_1" }),
    ];
    const meta = { toolUseId: "toolu_1", agentType: "dp-reviewer", description: "review pass" };
    const subRecords = [assistantRecord({ id: "s1", ts: "t2", stop_reason: "end_turn", output_tokens: 20 })];
    const sessionId = "55555555-5555-5555-5555-555555555555";
    const fixture = buildClaudeCodeFixture({
      sessionId,
      records,
      subagents: [{ id: "agent-1", meta, records: subRecords }],
    });
    const result = readClaudeCodeSession({ ...fixture, sessionId, cwdRoots: ["/repo"] });
    const grouped = groupTurnsByClass(result.turns);
    assert.equal(grouped.user.count, 1);
    assert.equal(grouped.user.tokens.output, 10);
    assert.equal(grouped["subagent:dp-reviewer"].count, 1);
    assert.equal(grouped["subagent:dp-reviewer"].tokens.output, 20);
    assert.equal(grouped.unsupported, undefined, "no unsupported turns expected in this fixture");
  });

  it("a main-context row with no origin_class (e.g. the Codex read path, which never sets it) lands in unsupported and does NOT inflate user's count (acceptance: unsupported not merged into other classes)", () => {
    const turns = [
      { actor: "main", origin_class: "user", tokens: { input: 0, output: 1, cache_read: 0, cache_creation: 0 }, children: [] },
      { actor: "main", tokens: { input: 0, output: 2, cache_read: 0, cache_creation: 0 }, children: [] },
    ];
    const grouped = groupTurnsByClass(turns);
    assert.equal(grouped.user.count, 1);
    assert.equal(grouped.user.tokens.output, 1, "the marker-less row's output must not leak into user");
    assert.equal(grouped.unsupported.count, 1);
    assert.equal(grouped.unsupported.tokens.output, 2);
  });

  it("Codex host: real readCodexSession output (not a synthetic proxy) lands entirely in unsupported, never user (acceptance: D13 R7 Codex-host carrier is backed by the actual reader path)", () => {
    const filename = "rollout-2026-01-01T00-00-00-25252525-2525-2525-2525-252525252525.jsonl";
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 1000,
        cached_input_tokens: 200,
        output_tokens: 100,
        totalTokenUsage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "25252525-2525-2525-2525-252525252525" });
    assert.ok(result.turns.length > 0, "fixture must actually produce turns to prove the claim");
    const grouped = groupTurnsByClass(result.turns);
    assert.equal(grouped.user, undefined, "Codex turns must never silently inflate the user bucket");
    assert.equal(
      grouped.unsupported.count,
      result.turns.length,
      "every Codex turn — not just some — must land in unsupported",
    );
  });
});

// ===========================================================================
// T2a — Claude Code cost-state reader
// ===========================================================================

describe("T2a Claude Code cost-state reader", () => {
  it("with cost-state: cost_usd is transcribed verbatim from totalCostUSD", () => {
    const records = [
      assistantRecord({ id: "m1", ts: "t1", model: "claude-opus-4" }),
      costStateRecord({
        totalCostUSD: 1.23,
        modelUsage: { "claude-opus-4": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 0 } },
      }),
    ];
    const result = extractCostState(records);
    assert.equal(result.cost_usd, 1.23);
    assert.deepEqual(result.gaps, []);
  });

  it("0 cost-state lines: cost_usd is null (not 0) and gaps names no-cost-state", () => {
    const result = extractCostState([]);
    assert.equal(result.cost_usd, null);
    assert.deepEqual(result.gaps, [{ name: "no-cost-state" }]);
  });

  it("model absent from transcript is named in gaps", () => {
    const records = [
      assistantRecord({ id: "m1", ts: "t1", model: "claude-opus-4" }),
      costStateRecord({
        totalCostUSD: 2,
        modelUsage: {
          "claude-opus-4": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          "claude-haiku-4": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        },
      }),
    ];
    const result = extractCostState(records);
    assert.ok(result.gaps.some((g) => g.name === "model-absent-from-transcript" && g.model === "claude-haiku-4"));
  });

  it("hasUnknownModelCost surfaces a named gap", () => {
    const result = extractCostState([costStateRecord({ totalCostUSD: 1, modelUsage: {}, hasUnknownModelCost: true })]);
    assert.ok(result.gaps.some((g) => g.name === "unknown-model-cost"));
  });

  it("host-internal cost-state field names do not leak into session-recap.md", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const recapPath = path.join(repoRoot, ".devpro/agent-rules/session-recap.md");
    const content = await fsp.readFile(recapPath, "utf8");
    assert.equal(/totalCostUSD|modelUsage|cost-state/u.test(content), false);
  });
});

// ===========================================================================
// T3 — subagent terminal-row dedup
// ===========================================================================

describe("T3 subagent reader", () => {
  it("subagent terminal row wins over streaming snapshot", () => {
    const meta = { toolUseId: "toolu_1", agentType: "general-purpose", description: "investigate the failure" };
    const records = [
      assistantRecord({ id: "s1", ts: "t1", stop_reason: null, output_tokens: 999 }),
      assistantRecord({ id: "s1", ts: "t2", stop_reason: "end_turn", output_tokens: 42 }),
    ];
    const subagent = parseSubagentTranscript(meta, records);
    assert.equal(subagent.tokens.output, 42);
    assert.equal(subagent.actor, "general-purpose");
    assert.equal(subagent.item, "investigate the failure");
  });

  it("collapseTerminalMessagesById: no terminal row anywhere in the group takes the max output_tokens", () => {
    const collapsed = collapseTerminalMessagesById([
      { id: "a", stop_reason: null, output_tokens: 5 },
      { id: "a", stop_reason: null, output_tokens: 12 },
    ]);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].output_tokens, 12);
  });

  // #2627 / D1 / F1 — prove-it + harden (T1/T2).
  // Limitation: issue-observed live collapsed shape was not available in-repo;
  // fixtures use iterable / array-like / unconvertible stand-ins plus a no-`.at`
  // Array.prototype deletion to lock the prior TypeError path.
  describe("#2627 asMessageArray harden (D1/F1)", () => {
    it("Array input is returned as-is", () => {
      const input = [{ id: "a", ts: "t1" }];
      const result = asMessageArray(input);
      assert.equal(result.ok, true);
      assert.equal(result.messages, input);
      assert.equal(result.gap, null);
    });

    it("iterable collapsed deduped preserves elements (no silent empty array)", () => {
      function* gen() {
        yield { id: "m1", ts: "t1", output_tokens: 3 };
        yield { id: "m2", ts: "t2", output_tokens: 9 };
      }
      const result = asMessageArray(gen());
      assert.equal(result.ok, true);
      assert.equal(result.gap, null);
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[1].id, "m2");
    });

    it("array-like collapsed deduped preserves elements via Array.from", () => {
      const arrayLike = {
        0: { id: "x", ts: "t0", output_tokens: 1 },
        1: { id: "y", ts: "t1", output_tokens: 2 },
        length: 2,
      };
      const result = asMessageArray(arrayLike);
      assert.equal(result.ok, true);
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[1].id, "y");
    });

    it("unconvertible structure records collapsed-deduped-unconvertible and is not ok", () => {
      const result = asMessageArray({ not: "convertible" });
      assert.equal(result.ok, false);
      assert.deepEqual(result.messages, []);
      assert.equal(result.gap?.name, "collapsed-deduped-unconvertible");
    });

    it("parse paths survive without Array.prototype.at (index tail access)", () => {
      const originalAt = Array.prototype.at;
      try {
        // Simulate hosts / exotic arrays where `.at` is missing.
        // eslint-disable-next-line no-extend-native
        delete Array.prototype.at;
        assert.equal(typeof [].at, "undefined");

        const turns = parseClaudeCodeTurns([
          userRecord({ id: "u1", ts: "t0", text: "hi" }),
          assistantRecord({ id: "m1", ts: "t1", stop_reason: "end_turn", output_tokens: 7 }),
        ]);
        assert.equal(turns.length, 1);
        assert.equal(turns[0].tokens.output, 7);

        const sub = parseSubagentTranscript(
          { toolUseId: "toolu_x", agentType: "Explore", description: "probe" },
          [assistantRecord({ id: "s1", ts: "t2", stop_reason: "end_turn", output_tokens: 11 })],
        );
        assert.equal(sub.tokens.output, 11);
        assert.equal(sub.terminal_message_id, "s1");
        assert.equal(sub.end_ts, "t2");
      } finally {
        Array.prototype.at = originalAt;
      }
    });

    it("normal Array collapse path remains green after harden", () => {
      const meta = { toolUseId: "toolu_1", agentType: "general-purpose", description: "ok" };
      const sub = parseSubagentTranscript(meta, [
        assistantRecord({ id: "s1", ts: "t1", stop_reason: null, output_tokens: 1 }),
        assistantRecord({ id: "s1", ts: "t2", stop_reason: "end_turn", output_tokens: 5 }),
      ]);
      assert.equal(sub.tokens.output, 5);
      assert.equal(sub.harden_gap, undefined);
    });
  });

  it("oversized transcript (551 MB class) degrades to unavailable instead of aborting", () => {
    // 2026-10-25 事故：551 MB 的 Claude 對話紀錄讓 readFileSync 丟 ERR_STRING_TOO_LONG，
    // second-review renderer 的成本 advisory 與 post-PR hook 一起中止。現在超過上限
    // 只回具名原因，上層降級成 unavailable。
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const root = "/claude-root";
    const projectDir = "proj";
    const mainPath = `${root}/projects/${projectDir}/${sessionId}.jsonl`;
    const dirs = {
      [root]: ["projects"],
      [`${root}/projects`]: [projectDir],
      [`${root}/projects/${projectDir}`]: [`${sessionId}.jsonl`],
    };
    const listDir = (p) => fixturePathRequired(dirs, p);
    const result = readClaudeCodeSession({
      root,
      listDir,
      readFile: () => { throw Object.assign(new Error("Invalid string length"), { code: "ERR_STRING_TOO_LONG" }); },
      fileSize: (p) => { assert.equal(p, mainPath); return MAX_TRANSCRIPT_BYTES + 1; },
      realpath: (p) => p,
      sessionId,
      cwdRoots: ["/repo"],
    });
    assert.equal(result.available, false);
    assert.match(result.reason, /too large/);
  });

  it("flat agent-*.meta.json + agent-*.jsonl layout loads subagents (real CC on-disk shape)", () => {
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const agentId = "a00bfa94b81640d25";
    const records = [
      userRecord({ id: "u1", ts: "t0", cwd: "/repo", text: "spawn sub" }),
      assistantRecord({ id: "m1", ts: "t1", output_tokens: 5, input_tokens: 2, toolUseId: "toolu_flat" }),
    ];
    const subRecords = [
      assistantRecord({ id: "s1", ts: "t2", stop_reason: "end_turn", output_tokens: 99, input_tokens: 4 }),
    ];
    const root = "/claude-root";
    const projectDir = "proj";
    const mainPath = `${root}/projects/${projectDir}/${sessionId}.jsonl`;
    const subDir = `${root}/projects/${projectDir}/${sessionId}/subagents`;
    const dirs = {
      [root]: ["projects"],
      [`${root}/projects`]: [projectDir],
      [`${root}/projects/${projectDir}`]: [`${sessionId}.jsonl`],
      [subDir]: [`agent-${agentId}.meta.json`, `agent-${agentId}.jsonl`],
    };
    const files = {
      [mainPath]: records.map((r) => JSON.stringify(r)).join("\n"),
      [`${subDir}/agent-${agentId}.meta.json`]: JSON.stringify({
        agentType: "general-purpose",
        description: "flat layout sub",
        toolUseId: "toolu_flat",
      }),
      [`${subDir}/agent-${agentId}.jsonl`]: subRecords.map((r) => JSON.stringify(r)).join("\n"),
    };
    const listDir = (p) => fixturePathRequired(dirs, p);
    const readFile = (p) => fixturePathRequired(files, p);
    const result = readClaudeCodeSession({ root, listDir, readFile, realpath: (p) => p, sessionId, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    assert.equal(result.gaps.some((g) => g.name === "subagent-read-failed"), false);
    const rows = result.turns.flatMap((t) => [t, ...(t.children ?? [])]);
    const subRow = rows.find((r) => r.actor === "general-purpose" && r.item === "flat layout sub");
    assert.ok(subRow);
    assert.equal(subRow.tokens.output, 99);
    assert.equal(result.totals.output, 104);
  });
});

// ===========================================================================
// T4 — token aggregation semantics + reconciliation
// ===========================================================================

describe("T4 token aggregation", () => {
  it("cache_read is summed as billable spend, cache_read_peak takes max", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "do it" }),
      ...[1000, 2000, 1500, 3000, 500].map((v, i) =>
        assistantRecord({ id: `m${i}`, ts: `t${i}`, cache_read_input_tokens: v }),
      ),
    ];
    const turns = parseClaudeCodeTurns(records);
    assert.equal(turns[0].tokens.cache_read, 8000);
    assert.equal(turns[0].tokens.cache_read_peak, 3000);
    assert.notEqual(turns[0].tokens.cache_read, turns[0].tokens.cache_read_peak);
  });

  it("internal conservation: turn.tokens.output + children.tokens.output equals deduped assistant output_tokens sum (no under/over count)", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "do it", cwd: "/repo" }),
      // streaming duplicates for m1: no terminal row anywhere -> max(5,12) = 12
      assistantRecord({ id: "m1", ts: "t1", stop_reason: null, output_tokens: 5 }),
      assistantRecord({ id: "m1", ts: "t1b", stop_reason: null, output_tokens: 12 }),
      // m2: single terminal row
      assistantRecord({ id: "m2", ts: "t2", stop_reason: "end_turn", output_tokens: 8, toolUseId: "toolu_sub" }),
    ];
    const subagentRecords = [
      assistantRecord({ id: "s1", ts: "t3", stop_reason: null, output_tokens: 3 }),
      assistantRecord({ id: "s1", ts: "t4", stop_reason: "end_turn", output_tokens: 7 }),
    ];
    const fixture = buildClaudeCodeFixture({
      sessionId: "11111111-1111-1111-1111-111111111111",
      records,
      subagents: [
        { id: "agent1", meta: { toolUseId: "toolu_sub", agentType: "general-purpose", description: "sub task" }, records: subagentRecords },
      ],
    });
    const result = readClaudeCodeSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    const turnOutput = result.turns.reduce((acc, t) => acc + t.tokens.output, 0);
    const childOutput = result.turns.reduce((acc, t) => acc + t.children.reduce((a, c) => a + c.tokens.output, 0), 0);
    // Known-correct hand-computed total: m1 deduped to 12 (max, no terminal), m2=8, s1 deduped to 7 (terminal wins).
    assert.equal(turnOutput + childOutput, 12 + 8 + 7);
  });

  it("ledger totals reconcile with host reported usage or name a gap (Claude Code, available)", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" }),
      assistantRecord({ id: "m1", ts: "t1", cache_read_input_tokens: 100, model: "claude-opus-4" }),
      costStateRecord({
        totalCostUSD: 1,
        modelUsage: { "claude-opus-4": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 } },
      }),
    ];
    const fixture = buildClaudeCodeFixture({ sessionId: "22222222-2222-2222-2222-222222222222", records });
    const result = readClaudeCodeSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.field_availability.cache_read, "available");
    assert.equal(result.totals.cache_read, 100);
  });

  it("ledger totals reconcile with host reported usage or name a gap (Claude Code, unreconciled)", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" }),
      assistantRecord({ id: "m1", ts: "t1", cache_read_input_tokens: 100, model: "claude-opus-4" }),
      costStateRecord({
        totalCostUSD: 1,
        modelUsage: { "claude-opus-4": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 60, cacheCreationInputTokens: 0 } },
      }),
    ];
    const fixture = buildClaudeCodeFixture({ sessionId: "33333333-3333-3333-3333-333333333333", records });
    const result = readClaudeCodeSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.field_availability.cache_read, "unreconciled");
    assert.equal(result.totals.cache_read, 100, "totals must print the LEDGER total, not the host total");
    const gap = result.gaps.find((g) => g.name === "cache-read-unreconciled");
    assert.ok(gap);
    assert.equal(gap.ledger_total, 100);
    assert.equal(gap.host_total, 60);
    assert.equal(gap.delta, 40);
  });

  it("0 cost-state: cache_read is unverified-on-host, gap carries no host_total/delta keys", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" }),
      assistantRecord({ id: "m1", ts: "t1", cache_read_input_tokens: 100 }),
    ];
    const fixture = buildClaudeCodeFixture({ sessionId: "44444444-4444-4444-4444-444444444444", records });
    const result = readClaudeCodeSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.field_availability.cache_read, "unverified-on-host");
    assert.equal(result.totals.cache_read, 100);
    const gap = result.gaps.find((g) => g.name === "no-cost-state");
    assert.ok(gap);
    assert.ok(!Object.hasOwn(gap, "host_total"));
    assert.ok(!Object.hasOwn(gap, "delta"));
  });
});

// ===========================================================================
// T5 — Codex reader
// ===========================================================================

describe("T5 Codex reader", () => {
  it("Scenario: Legacy-only Codex sessions preserve existing totals", () => {
    const sessionId = "52525252-5252-5252-5252-525252525252";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 30,
        totalTokenUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });

    const result = readCodexSession({ ...fixture, sessionId });

    assert.equal(result.totals.input, 80);
    assert.equal(result.usage_reconciliation.status, "reconciled");
    assert.equal(result.usage_source, "legacy-token-count");
    assert.equal(result.usage_segments[0].source, "legacy-token-count");
    assert.equal(result.usage_attribution.status, "unverified", "fallback token rows have no verified turn boundary");
    assert.equal(result.unassigned_usage.rows.length, 1);
    assert.equal(result.totals.output, 30);
    assert.equal(result.totals.cache_read, 20);
  });

  it("Scenario: Unique response records reconcile to the final thread cumulative", () => {
    const sessionId = "51515151-5151-5151-5151-515151515151";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const usage = {
      input_tokens: 100,
      cached_input_tokens: 20,
      cache_write_input_tokens: 0,
      output_tokens: 30,
      reasoning_output_tokens: 5,
      total_tokens: 130,
    };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      taskStartedEvent({ turnId: "turn-1", ts: "t1" }),
      tokenUsageRecordEvent({
        ts: "t2",
        threadId: sessionId,
        responseId: "response-1",
        turnId: "turn-1",
        usage,
        threadTokenUsage: usage,
      }),
      taskCompleteEvent({ turnId: "turn-1", ts: "t3" }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });

    const result = readCodexSession({ ...fixture, sessionId });

    assert.equal(result.totals.input, 80);
    assert.equal(result.usage_reconciliation.status, "reconciled");
    assert.equal(result.usage_source, "token-usage-record");
    assert.equal(result.usage_segments[0].source, "token-usage-record");
    assert.equal(result.usage_attribution.status, "verified");
  });

  it("Codex response usage contributes once per canonical thread", () => {
    const sessionId = "53535353-5353-5353-5353-535353535353";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const usage = {
      input_tokens: 100,
      cached_input_tokens: 20,
      cache_write_input_tokens: 0,
      output_tokens: 30,
      reasoning_output_tokens: 5,
      total_tokens: 130,
    };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      taskStartedEvent({ turnId: "turn-1", ts: "t1" }),
      tokenUsageRecordEvent({ ts: "t2", threadId: sessionId, responseId: "response-1", turnId: "turn-1", usage, threadTokenUsage: usage }),
      tokenUsageRecordEvent({ ts: "t3", threadId: sessionId, responseId: "response-1", turnId: "turn-1", usage, threadTokenUsage: usage }),
      taskCompleteEvent({ turnId: "turn-1", ts: "t4" }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });

    const result = readCodexSession({ ...fixture, sessionId });

    assert.equal(result.totals.input, 80);
    assert.equal(result.usage_reconciliation.status, "reconciled");
    assert.equal(result.usage_segments[0].duplicate_count, 1);
  });

  it("keeps root legacy rows together across foreign-thread records", () => {
    const sessionId = "53535353-5353-4353-8353-535353535353";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const foreignUsage = { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12 };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      tokenCountEvent({ ts: "t1", input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, totalTokenUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } }),
      tokenUsageRecordEvent({ ts: "t2", threadId: "53535353-5353-4353-8353-535353535354", responseId: "foreign-response", turnId: null, usage: foreignUsage, threadTokenUsage: foreignUsage }),
      tokenCountEvent({ ts: "t3", input_tokens: 50, cached_input_tokens: 10, output_tokens: 15, totalTokenUsage: { input_tokens: 150, cached_input_tokens: 30, output_tokens: 45 } }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId });

    const legacySegments = result.usage_segments.filter((segment) => segment.source === "legacy-token-count");
    const legacyRows = result.unassigned_usage.rows.filter((row) => row.source === "legacy-token-count");
    assert.equal(legacySegments.length, 1);
    assert.equal(legacySegments[0].totals.input, 120);
    assert.equal(result.totals.input, 120);
    assert.equal(legacyRows.length, 2);
    assert.equal(legacyRows.reduce((sum, row) => sum + row.tokens.input, 0), 120);
    const sinceChange = aggregateSinceChangeUsage({
      sessions: [{ session_id: sessionId, start_ts: "t0", host: "codex" }],
      collectSessionUsage: () => ({ ...result, available: true }),
      roots: { claudeRoot: "/unused", codexRoot: "/unused" },
      env: {},
      getSessionTransitions: () => ({ status: "ok", records: [] }),
    });
    assert.equal(sinceChange.totals.input, 120, "all selected legacy rows remain in current-change totals");
  });

  it("keeps interleaved root legacy and record streams grouped by source", () => {
    const sessionId = "53535353-5353-4353-8353-535353535355";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const firstUsage = { input_tokens: 20, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 1, total_tokens: 26 };
    const secondUsage = { input_tokens: 30, cached_input_tokens: 6, cache_write_input_tokens: 0, output_tokens: 9, reasoning_output_tokens: 2, total_tokens: 39 };
    const finalCumulative = { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 15, reasoning_output_tokens: 3, total_tokens: 65 };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      tokenCountEvent({ ts: "t1", input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, totalTokenUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } }),
      tokenUsageRecordEvent({ ts: "t2", threadId: sessionId, responseId: "response-1", turnId: null, usage: firstUsage, threadTokenUsage: firstUsage }),
      tokenCountEvent({ ts: "t3", input_tokens: 50, cached_input_tokens: 10, output_tokens: 15, totalTokenUsage: { input_tokens: 150, cached_input_tokens: 30, output_tokens: 45 } }),
      tokenUsageRecordEvent({ ts: "t4", threadId: sessionId, responseId: "response-2", turnId: null, usage: secondUsage, threadTokenUsage: finalCumulative }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId });

    const recordSegment = result.usage_segments.find((segment) => segment.source === "token-usage-record" && segment.thread_attribution === "root");
    const recordRows = result.unassigned_usage.rows.filter((row) => row.source === "token-usage-record");
    assert.equal(result.usage_source, "mixed-unresolved");
    assert.equal(recordSegment.response_count, 2);
    assert.equal(recordSegment.raw_usage_totals.input_tokens, 50);
    assert.equal(result.totals.input, 40);
    assert.equal(recordRows.length, 2);
    assert.equal(recordRows.reduce((sum, row) => sum + row.tokens.input, 0), 40);
    const sinceChange = aggregateSinceChangeUsage({
      sessions: [{ session_id: sessionId, start_ts: "t0", host: "codex" }],
      collectSessionUsage: () => ({ ...result, available: true }),
      roots: { claudeRoot: "/unused", codexRoot: "/unused" },
      env: {},
      getSessionTransitions: () => ({ status: "ok", records: [] }),
    });
    assert.equal(sinceChange.totals.input, 40, "all selected record rows remain in current-change totals");
  });

  it("keeps legacy cumulative reset epochs separate", () => {
    const sessionId = "53535353-5353-4353-8353-535353535356";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      tokenCountEvent({ ts: "t1", input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, totalTokenUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } }),
      tokenCountEvent({ ts: "t2", input_tokens: 25, cached_input_tokens: 5, output_tokens: 8, totalTokenUsage: { input_tokens: 25, cached_input_tokens: 5, output_tokens: 8 } }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId });
    const legacySegments = result.usage_segments.filter((segment) => segment.source === "legacy-token-count");

    assert.equal(result.usage_source, "mixed-unresolved");
    assert.equal(legacySegments.length, 2);
    assert.equal(legacySegments[1].reset_boundary, true);
    assert.equal(result.totals.input, 20);
    assert.ok(result.gaps.some((gap) => gap.name === "codex-usage-mixed-unresolved"));

    const sinceChange = aggregateSinceChangeUsage({
      sessions: [{ session_id: sessionId, start_ts: "t0", host: "codex" }],
      collectSessionUsage: () => ({ ...result, available: true }),
      roots: { claudeRoot: "/unused", codexRoot: "/unused" },
      env: {},
      getSessionTransitions: () => ({ status: "ok", records: [] }),
    });
    assert.equal(sinceChange.sessions[0].totals.input, 20, "the current-change session totals use the latest reset epoch");
    assert.equal(sinceChange.totals.input, sinceChange.sessions[0].totals.input);
    assert.equal(sinceChange.sessions[0].usage_segments.at(-1).totals.input, sinceChange.sessions[0].totals.input);
  });

  it("keeps foreign-thread reconciliation gaps out of root totals", () => {
    const sessionId = "53535353-5353-4353-8353-535353535357";
    const foreignId = "53535353-5353-4353-8353-535353535358";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const rootUsage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const foreignUsage = { input_tokens: 20, cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 1, total_tokens: 28 };
    const foreignCumulative = { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 2, total_tokens: 70 };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      tokenUsageRecordEvent({ ts: "t1", threadId: sessionId, responseId: "root-response", turnId: null, usage: rootUsage, threadTokenUsage: rootUsage }),
      tokenUsageRecordEvent({ ts: "t2", threadId: foreignId, responseId: "foreign-response", turnId: null, usage: foreignUsage, threadTokenUsage: foreignCumulative }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId });

    assert.ok(result.gaps.some((gap) => gap.name === "codex-usage-cumulative-mismatch"));
    assert.equal(result.usage_reconciliation.status, "reconciled");
    assert.equal(result.totals.input, 80);
  });

  it("preserves raw usage for records without a response identity as diagnostics", () => {
    const sessionId = "53535353-5353-4353-8353-535353535359";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      tokenUsageRecordEvent({ ts: "t1", threadId: sessionId, responseId: null, turnId: null, usage, threadTokenUsage: usage }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId });

    assert.equal(result.usage_reconciliation.status, "unverified");
    assert.equal(result.usage_attribution.unknown_response_event_count, 1);
    assert.equal(result.unassigned_usage.unknown_response_rows.length, 1);
    assert.equal(result.unassigned_usage.unknown_response_rows[0].tokens.input, 80);
    assert.equal(result.unassigned_usage.unknown_response_totals.input, 80);
    const sinceChange = aggregateSinceChangeUsage({
      sessions: [{ session_id: sessionId, start_ts: "t0", host: "codex" }],
      collectSessionUsage: () => ({ ...result, available: true }),
      roots: { claudeRoot: "/unused", codexRoot: "/unused" },
      env: {},
      getSessionTransitions: () => ({ status: "ok", records: [] }),
    });
    assert.equal(sinceChange.totals.input, 0, "unidentified responses stay out of canonical change totals");
    assert.equal(sinceChange.sessions[0].unassigned_usage.unknown_response_totals.input, 80);
    assert.equal(sinceChange.sessions[0].usage_attribution.status, "unverified");
    const markdown = renderMarkdownLedger({ host: "codex", ...result }, {});
    assert.ok(markdown.includes("unknown_response_usage(input=80,output=30,cache_read=20)"));
  });

  it("does not treat an unresolved thread ID as root usage", () => {
    const sessionId = "53535353-5353-4353-8353-535353535360";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const records = [
      tokenUsageRecordEvent({ ts: "t1", threadId: null, responseId: "unknown-root-response", turnId: null, usage, threadTokenUsage: usage }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId });

    assert.equal(result.usage_source, null);
    assert.equal(result.totals.input, 0);
    assert.equal(result.unassigned_usage.unknown_thread_totals.input, 80);
    assert.equal(result.usage_attribution.status, "unverified");
  });

  it("keeps record usage unresolved when latest-session discovery has no root thread ID", () => {
    const sessionId = "53535353-5353-4353-8353-535353535361";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const mismatchedCumulative = { ...usage, input_tokens: 110 };
    const fixture = buildCodexFixture({
      filenames: {
        [filename]: [
          { type: "session_meta", timestamp: "t0", payload: { cwd: "/repo" } },
          tokenUsageRecordEvent({ ts: "t1", threadId: sessionId, responseId: "unresolved-root-response", turnId: null, usage, threadTokenUsage: mismatchedCumulative }),
        ],
      },
    });
    const result = readCodexSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });

    assert.equal(result.source, "latest-fallback");
    assert.equal(result.usage_source, null);
    assert.equal(result.totals.input, null);
    assert.equal(result.usage_segments[0].thread_attribution, "unresolved");
    assert.ok(result.gaps.some((gap) => gap.name === "codex-usage-cumulative-mismatch" && gap.thread_attribution === "unresolved"));
  });

  it("Scenario: Foreign and unassigned Codex thread usage keeps its attribution boundary", () => {
    const rootId = "58585858-5858-4858-8858-585858585858";
    const childId = "59595959-5959-4959-8959-595959595959";
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-codex-foreign-thread-"));
    const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const cumulative = { ...usage };
    const foreign = tokenUsageRecordEvent({ ts: "t2", threadId: childId, responseId: "child-response", turnId: "child-turn", usage, threadTokenUsage: cumulative });
    try {
      const codexRoot = path.join(tmp, "codex");
      writeCodexFixtureToDisk(codexRoot, rootId, [
        sessionMetaRecord({ sessionId: rootId, cwd: process.cwd(), ts: "2026-01-01T00:00:00Z" }),
        spawnAgentCall({ ts: "2026-01-01T00:00:01Z", agentType: "dp-programmer" }),
        { ...foreign, timestamp: "2026-01-01T00:00:02Z" },
      ]);
      writeCodexFixtureToDisk(codexRoot, childId, [
        {
          type: "session_meta",
          timestamp: "2026-01-01T00:10:00Z",
          payload: { id: childId, cwd: process.cwd(), source: { subagent: { thread_spawn: { parent_thread_id: rootId } } } },
        },
        tokenUsageRecordEvent({ ts: "2026-01-01T00:10:01Z", threadId: childId, responseId: "child-response", turnId: "child-turn", usage, threadTokenUsage: cumulative }),
        tokenUsageRecordEvent({ ts: "2026-01-01T00:10:02Z", threadId: childId, responseId: "child-response", turnId: "child-turn", usage, threadTokenUsage: cumulative }),
      ]);

      const output = captureConsoleLog(() => reportCliMain(["--host", "codex", "--session", rootId, "--lineage", "--json"], {
        HOME: tmp,
        DEVPRO_TEST_CODEX_ROOT: codexRoot,
      }));
      const parsed = JSON.parse(output);

      assert.equal(parsed.totals.input, 0, "the foreign child thread must not inflate the root subtotal");
      assert.equal(parsed.usage_segments.find((segment) => segment.thread_attribution === "foreign").totals.input, 80);
      assert.equal(parsed.lineage.counts.descendant_sessions, 1);
      assert.equal(parsed.lineage.metrics.input.root, 0);
      assert.equal(parsed.lineage.metrics.input.descendants, 80, "the descendant's repeated response is counted once in its own rollout");
      assert.equal(parsed.lineage.metrics.input.lineage_inclusive, 80, "the foreign root copy does not duplicate descendant usage");
      const child = parsed.lineage.contributors.find((contributor) => contributor.role === "descendant");
      assert.equal(child.usage_source, "token-usage-record");
      assert.equal(child.usage_reconciliation.status, "reconciled");
      assert.equal(child.usage_segments.length, 1);
      assert.equal(child.usage_attribution.status, "unverified", "the child record has no observed turn boundary");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Scenario: Outside-turn Codex usage is included once without unsupported change attribution", () => {
    const sessionId = "60606060-6060-4060-8060-606060606060";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const lateUsage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const outsideUsage = { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 2, total_tokens: 57 };
    const finalCumulative = { input_tokens: 150, cached_input_tokens: 30, cache_write_input_tokens: 0, output_tokens: 37, reasoning_output_tokens: 7, total_tokens: 187 };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      taskStartedEvent({ turnId: "closed-turn", ts: "t1" }),
      tokenUsageRecordEvent({ ts: "t1.5", threadId: sessionId, responseId: "late-response", turnId: null, usage: lateUsage, threadTokenUsage: lateUsage }),
      taskCompleteEvent({ turnId: "closed-turn", ts: "t2" }),
      tokenUsageRecordEvent({ ts: "t3", threadId: sessionId, responseId: "late-response", turnId: "closed-turn", usage: lateUsage, threadTokenUsage: lateUsage }),
      tokenUsageRecordEvent({ ts: "t4", threadId: sessionId, responseId: "outside-response", turnId: null, usage: outsideUsage, threadTokenUsage: finalCumulative }),
      tokenUsageRecordEvent({ ts: "t5", threadId: sessionId, responseId: "outside-response", turnId: null, usage: outsideUsage, threadTokenUsage: finalCumulative }),
      tokenUsageRecordEvent({ ts: "t6", threadId: null, responseId: "unknown-thread-response", turnId: null, usage: outsideUsage, threadTokenUsage: finalCumulative }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });

    const result = readCodexSession({ ...fixture, sessionId });

    assert.deepEqual(result.turns.map((turn) => turn.tokens.input), [80], "a late record with a resolvable turn id still belongs to that turn");
    assert.deepEqual(result.unassigned_usage.rows.map((row) => row.tokens.input), [40], "a repeated outside-turn response is retained once in the unassigned bucket");
    assert.equal(result.unassigned_usage.unknown_thread_events.length, 1, "missing thread identity stays explicitly unassigned");
    assert.equal(result.unassigned_usage.unknown_thread_rows.length, 1, "unknown-thread counters remain visible in a distinct unassigned bucket");
    assert.deepEqual(result.unassigned_usage.unknown_thread_totals, {
      input: 40,
      output: 7,
      cache_read: 10,
      cache_creation: null,
    });
    const markdown = renderMarkdownLedger({ host: "codex", ...result }, {});
    assert.ok(markdown.includes("unknown_thread_usage(input=40,output=7,cache_read=10)"));
    assert.equal(result.totals.input, 120, "session totals include the late and outside-turn root responses exactly once");
    assert.equal(result.usage_reconciliation.status, "unverified", "unknown thread metering cannot be reconciled as a complete root total");
    assert.equal(result.usage_attribution.status, "unverified");

    const sinceChange = aggregateSinceChangeUsage({
      sessions: [{ session_id: sessionId, start_ts: "t0", host: "codex" }],
      collectSessionUsage: () => ({ ...result, available: true }),
      roots: { claudeRoot: "/unused", codexRoot: "/unused" },
      env: {},
      getSessionTransitions: () => ({ status: "ok", records: [] }),
    });
    assert.equal(sinceChange.totals.input, 120, "unknown-thread usage is not claimed in current-change totals");
    assert.equal(sinceChange.sessions[0].unassigned_usage.unknown_thread_totals.input, 40);
    assert.equal(sinceChange.sessions[0].usage_attribution.status, "unverified");
  });

  it("Scenario: Conflicting response records do not select a guessed value", () => {
    const sessionId = "54545454-5454-5454-5454-545454545454";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const first = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const conflict = { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 150 };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      taskStartedEvent({ turnId: "turn-1", ts: "t1" }),
      tokenUsageRecordEvent({ ts: "t2", threadId: sessionId, responseId: "response-1", turnId: "turn-1", usage: first, threadTokenUsage: first }),
      tokenUsageRecordEvent({ ts: "t3", threadId: sessionId, responseId: "response-1", turnId: "turn-1", usage: conflict, threadTokenUsage: { ...conflict, input_tokens: 220, total_tokens: 250 } }),
      taskCompleteEvent({ turnId: "turn-1", ts: "t4" }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });

    const result = readCodexSession({ ...fixture, sessionId });

    const conflictGap = result.gaps.find((gap) => gap.name === "codex-response-usage-conflict");
    assert.ok(conflictGap);
    assert.ok(conflictGap.metrics.includes("input_tokens"));
    assert.equal(result.usage_reconciliation.status, "unverified");

    const sinceChange = aggregateSinceChangeUsage({
      sessions: [{ session_id: sessionId, start_ts: "t1", host: "codex" }],
      collectSessionUsage: () => ({ ...result, available: true }),
      roots: { claudeRoot: "/unused", codexRoot: "/unused" },
      env: {},
      getSessionTransitions: () => ({ status: "ok", records: [] }),
    });
    assert.equal(sinceChange.sessions[0].totals.output, 30, "a conflicted input counter must not erase valid output usage");
    assert.equal(sinceChange.sessions[0].totals.cache_read, 20, "a conflicted input counter must not erase valid cache-read usage");
    assert.equal(sinceChange.sessions[0].usage_reconciliation.status, "unverified");
  });

  it("Scenario: Missing cumulative metrics produce a named gap and unverified reconciliation", () => {
    const sessionId = "63636363-6363-4363-8363-636363636363";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const cumulative = { ...usage };
    delete cumulative.output_tokens;
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      taskStartedEvent({ turnId: "turn-1", ts: "t1" }),
      tokenUsageRecordEvent({ ts: "t2", threadId: sessionId, responseId: "response-1", turnId: "turn-1", usage, threadTokenUsage: cumulative, turnTokenUsage: usage }),
      taskCompleteEvent({ turnId: "turn-1", ts: "t3" }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });

    const result = readCodexSession({ ...fixture, sessionId });

    const gap = result.gaps.find((entry) => entry.name === "codex-usage-cumulative-missing");
    assert.deepEqual(gap?.metrics, ["output_tokens"]);
    assert.equal(result.usage_segments[0].reconciliation, "unverified");
    assert.equal(result.usage_segments[0].totals.input, 80, "valid input usage remains visible");
    assert.equal(result.usage_segments[0].totals.cache_read, 20, "valid cache-read usage remains visible");
    assert.equal(result.usage_segments[0].totals.output, null, "the incomplete output reconciliation remains unknown");
    assert.equal(result.usage_segments[0].cumulative.output, null, "the missing cumulative is not invented");
    assert.equal(result.usage_reconciliation.status, "unverified");
  });

  it("Scenario: Malformed response metrics produce a named gap while valid counters remain visible", () => {
    const sessionId = "64646464-6464-4464-8464-646464646464";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const malformedUsage = { ...usage, output_tokens: "30" };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      taskStartedEvent({ turnId: "turn-1", ts: "t1" }),
      tokenUsageRecordEvent({ ts: "t2", threadId: sessionId, responseId: "response-1", turnId: "turn-1", usage: malformedUsage, threadTokenUsage: usage, turnTokenUsage: usage }),
      taskCompleteEvent({ turnId: "turn-1", ts: "t3" }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });

    const result = readCodexSession({ ...fixture, sessionId });

    const gap = result.gaps.find((entry) => entry.name === "codex-usage-value-invalid");
    assert.deepEqual(gap?.metrics, ["output_tokens"]);
    assert.equal(result.usage_segments[0].raw_usage_totals.output_tokens, null);
    assert.equal(result.usage_segments[0].totals.output, null);
    assert.equal(result.totals.input, 80, "valid input usage remains visible");
    assert.equal(result.totals.cache_read, 20, "valid cache-read usage remains visible");
    assert.equal(result.usage_reconciliation.status, "unverified");
  });

  it("Scenario: Mixed formats and cumulative resets remain separate diagnostics", () => {
    const mixedSessionId = "55555555-aaaa-5555-aaaa-555555555555";
    const mixedFilename = `rollout-2026-01-01T00-00-00-${mixedSessionId}.jsonl`;
    const legacy = tokenCountEvent({
      ts: "t0",
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 30,
      totalTokenUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 },
    });
    const recordUsage = { input_tokens: 70, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 2, total_tokens: 90 };
    const mixedRecords = [
      legacy,
      sessionMetaRecord({ sessionId: mixedSessionId, cwd: "/repo", ts: "t1" }),
      taskStartedEvent({ turnId: "turn-1", ts: "t2" }),
      tokenUsageRecordEvent({ ts: "t3", threadId: mixedSessionId, responseId: "response-1", turnId: "turn-1", usage: recordUsage, threadTokenUsage: recordUsage }),
      taskCompleteEvent({ turnId: "turn-1", ts: "t4" }),
    ];
    const mixedFixture = buildCodexFixture({ filenames: { [mixedFilename]: mixedRecords } });
    const mixed = readCodexSession({ ...mixedFixture, sessionId: mixedSessionId });

    assert.equal(mixed.usage_source, "mixed-unresolved");
    assert.equal(mixed.usage_segments.length, 2);
    assert.equal(mixed.usage_segments.find((segment) => segment.source === "legacy-token-count").totals.input, 80);
    assert.equal(mixed.totals.input, 60);
    assert.ok(mixed.gaps.some((gap) => gap.name === "codex-usage-mixed-unresolved"));
    assert.equal(mixed.usage_reconciliation.status, "unverified");

    const resetSessionId = "56565656-aaaa-5656-aaaa-565656565656";
    const resetFilename = `rollout-2026-01-01T00-00-00-${resetSessionId}.jsonl`;
    const beforeReset = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
    const afterReset = { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 15, reasoning_output_tokens: 2, total_tokens: 65 };
    const resetRecords = [
      sessionMetaRecord({ sessionId: resetSessionId, cwd: "/repo", ts: "t0" }),
      taskStartedEvent({ turnId: "turn-1", ts: "t1" }),
      tokenUsageRecordEvent({ ts: "t2", threadId: resetSessionId, responseId: "response-1", turnId: "turn-1", usage: beforeReset, threadTokenUsage: beforeReset }),
      tokenUsageRecordEvent({ ts: "t3", threadId: resetSessionId, responseId: "response-2", turnId: "turn-1", usage: afterReset, threadTokenUsage: afterReset }),
      taskCompleteEvent({ turnId: "turn-1", ts: "t4" }),
    ];
    const resetFixture = buildCodexFixture({ filenames: { [resetFilename]: resetRecords } });
    const reset = readCodexSession({ ...resetFixture, sessionId: resetSessionId });

    assert.equal(reset.usage_source, "mixed-unresolved");
    assert.equal(reset.usage_segments.length, 2);
    assert.equal(reset.totals.input, 40);
    assert.ok(reset.gaps.some((gap) => gap.name === "codex-usage-mixed-unresolved"));
    assert.equal(reset.usage_reconciliation.status, "unverified");
  });

  it("Scenario: Nonzero cache-write usage remains raw and unclassified", () => {
    const sessionId = "57575757-5757-5757-5757-575757575757";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const usage = {
      input_tokens: 100,
      cached_input_tokens: 20,
      cache_write_input_tokens: 7,
      output_tokens: 30,
      reasoning_output_tokens: 5,
      total_tokens: 130,
    };
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      taskStartedEvent({ turnId: "turn-1", ts: "t1" }),
      tokenUsageRecordEvent({ ts: "t2", threadId: sessionId, responseId: "response-1", turnId: "turn-1", usage, threadTokenUsage: usage }),
      taskCompleteEvent({ turnId: "turn-1", ts: "t3" }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });

    const result = readCodexSession({ ...fixture, sessionId });

    assert.ok(result.gaps.some((gap) => gap.name === "cache-write-input-tokens-nonzero"));
    assert.equal(result.totals.input, 80);
    assert.equal(result.usage_segments[0].raw_usage_totals.cache_write_input_tokens, 7);
  });

  it("cost_usd is null (not 0), children is []", () => {
    const filename = "rollout-2026-01-01T00-00-00-55555555-5555-5555-5555-555555555555.jsonl";
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 10,
        totalTokenUsage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "55555555-5555-5555-5555-555555555555" });
    assert.equal(result.cost_usd, null);
    assert.deepEqual(result.turns[0].children, []);
  });

  it("input is input_tokens minus cached_input_tokens (design-mandated magnitudes)", () => {
    const filename = "rollout-2026-01-01T00-00-00-66666666-6666-6666-6666-666666666666.jsonl";
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 15783,
        cached_input_tokens: 11008,
        output_tokens: 1200,
        totalTokenUsage: { input_tokens: 15783, cached_input_tokens: 11008, output_tokens: 1200 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "66666666-6666-6666-6666-666666666666" });
    assert.equal(result.turns[0].tokens.input, 4775);
  });

  it("non-double-count: output equals output_tokens, never output + reasoning_output_tokens", () => {
    const filename = "rollout-2026-01-01T00-00-00-77777777-7777-7777-7777-777777777777.jsonl";
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 15783,
        cached_input_tokens: 11008,
        output_tokens: 1200,
        reasoning_output_tokens: 300,
        total_tokens: 16983, // 15783 + 1200: proves reasoning is already inside output_tokens
        totalTokenUsage: { input_tokens: 15783, cached_input_tokens: 11008, output_tokens: 1200 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "77777777-7777-7777-7777-777777777777" });
    assert.equal(result.turns[0].tokens.output, 1200);
    assert.notEqual(result.turns[0].tokens.output, 1200 + 300);
    assert.equal(result.turns[0].tokens.reasoning, 300, "reasoning is a display-only breakdown, not additive");
  });

  it("conservation (i): total_tokens === input_tokens + output_tokens on a single fixture", () => {
    const event = tokenCountEvent({
      ts: "t0",
      input_tokens: 15783,
      cached_input_tokens: 11008,
      output_tokens: 1200,
      reasoning_output_tokens: 300,
      total_tokens: 16983,
    });
    const { input_tokens, output_tokens, total_tokens } = event.payload.info.last_token_usage;
    assert.equal(total_tokens, input_tokens + output_tokens);
  });

  it("ledger totals reconcile with host reported usage or name a gap (Codex, available)", () => {
    const filename = "rollout-2026-01-01T00-00-00-88888888-8888-8888-8888-888888888888.jsonl";
    const records = [
      tokenCountEvent({ ts: "t0", input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 }),
      tokenCountEvent({
        ts: "t1",
        input_tokens: 500,
        cached_input_tokens: 100,
        output_tokens: 50,
        totalTokenUsage: { input_tokens: 1500, cached_input_tokens: 300, output_tokens: 150 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "88888888-8888-8888-8888-888888888888" });
    assert.equal(result.field_availability.cache_read, "available");
    assert.equal(result.totals.cache_read, 300);
  });

  it("ledger totals reconcile with host reported usage or name a gap (Codex, unreconciled)", () => {
    const filename = "rollout-2026-01-01T00-00-00-99999999-9999-9999-9999-999999999999.jsonl";
    const records = [
      tokenCountEvent({ ts: "t0", input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 }),
      tokenCountEvent({
        ts: "t1",
        input_tokens: 500,
        cached_input_tokens: 100,
        output_tokens: 50,
        totalTokenUsage: { input_tokens: 1500, cached_input_tokens: 250, output_tokens: 150 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "99999999-9999-9999-9999-999999999999" });
    assert.equal(result.field_availability.cache_read, "unreconciled");
    const gap = result.gaps.find((g) => g.name === "cache-read-unreconciled");
    assert.ok(gap);
    assert.equal(gap.ledger_total, 300);
    assert.equal(gap.host_total, 250);
    assert.equal(gap.delta, 50);
  });

  it("turn-aware: task boundaries produce one row with item, duration, and summed tokens", () => {
    const turnId = "17171717-1717-1717-1717-171717171717";
    const content = [
      JSON.stringify(taskStartedEvent({ turnId, ts: "2026-08-27T07:13:53.481Z" })),
      JSON.stringify(codexUserMessage({ ts: "2026-08-27T07:13:55.299Z", text: "Implement telemetry T1\nsecond line" })),
      JSON.stringify(
        tokenCountEvent({
          ts: "2026-08-27T07:14:02.406Z",
          input_tokens: 15783,
          cached_input_tokens: 11008,
          output_tokens: 205,
        }),
      ),
      JSON.stringify(
        tokenCountEvent({
          ts: "2026-08-27T07:14:22.405Z",
          input_tokens: 17114,
          cached_input_tokens: 11008,
          output_tokens: 531,
          totalTokenUsage: { input_tokens: 17114, cached_input_tokens: 11008, output_tokens: 531 },
        }),
      ),
      JSON.stringify(taskCompleteEvent({ turnId, ts: "2026-08-27T07:16:03.383Z", durationMs: 129902 })),
    ].join("\n");
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.mode, "turn-aware");
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].item, "Implement telemetry T1");
    assert.equal(parsed.turns[0].duration_ms, 129902);
    assert.equal(parsed.turns[0].tokens.input, 4775 + 6106);
    assert.equal(parsed.turns[0].tokens.output, 205 + 531);
    assert.equal(parsed.turns[0].actor, "main");
  });

  it("turn-aware: user response_item before task_started is attached to the next turn", () => {
    const turnId = "1a1a1a1a-1a1a-1a1a-1a1a-1a1a1a1a1a1a";
    const content = [
      JSON.stringify(codexUserMessage({ ts: "2026-08-27T07:13:55.299Z", text: "Early user prompt\nsecond line" })),
      JSON.stringify(taskStartedEvent({ turnId, ts: "2026-08-27T07:13:53.481Z" })),
      JSON.stringify(tokenCountEvent({ ts: "t1", input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 })),
      JSON.stringify(taskCompleteEvent({ turnId, durationMs: 1200 })),
    ].join("\n");
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.mode, "turn-aware");
    assert.equal(parsed.turns[0].item, "Early user prompt");
  });

  it("turn-aware: user_message event_msg fills item when response_item is absent", () => {
    const turnId = "2b2b2b2b-2b2b-2b2b-2b2b-2b2b2b2b2b2b";
    const content = [
      JSON.stringify(codexUserMessageEvent({ ts: "t0", text: "Event-only user prompt" })),
      JSON.stringify(taskStartedEvent({ turnId })),
      JSON.stringify(tokenCountEvent({ ts: "t1", input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 })),
      JSON.stringify(taskCompleteEvent({ turnId, durationMs: 800 })),
    ].join("\n");
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.turns[0].item, "Event-only user prompt");
  });

  it("turn-aware: spawn_agent agent_type is labeled on item; actor stays main", () => {
    const turnId = "18181818-1818-1818-1818-181818181818";
    const content = [
      JSON.stringify(taskStartedEvent({ turnId })),
      JSON.stringify(codexUserMessage({ text: "dispatch review" })),
      JSON.stringify(spawnAgentCall({ agentType: "dp-reviewer" })),
      JSON.stringify(tokenCountEvent({ ts: "t2", input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 })),
      JSON.stringify(taskCompleteEvent({ turnId, durationMs: 5000 })),
    ].join("\n");
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.turns[0].actor, "main");
    assert.match(parsed.turns[0].item, /\[spawn: dp-reviewer\]/);
    assert.deepEqual(parsed.turns[0].spawn_agent_types, ["dp-reviewer"]);
  });

  it("turn-aware: token rows before and after spawn stay on main actor", () => {
    const turnId = "19191919-1919-1919-1919-191919191919";
    const content = [
      JSON.stringify(taskStartedEvent({ turnId })),
      JSON.stringify(tokenCountEvent({ ts: "t1", input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 })),
      JSON.stringify(spawnAgentCall({ agentType: "dp-programmer" })),
      JSON.stringify(tokenCountEvent({ ts: "t2", input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 })),
      JSON.stringify(taskCompleteEvent({ turnId, durationMs: 9000 })),
    ].join("\n");
    const parsed = parseCodexRollout(content);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].actor, "main");
    assert.equal(parsed.turns[0].tokens.input, 150);
    assert.match(parsed.turns[0].item, /\[spawn: dp-programmer\]/);
  });

  it("non-zero cache_write_input_tokens is a named gap, never silently dropped", () => {
    const filename = "rollout-2026-01-01T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl";
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 10,
        cache_write_input_tokens: 5,
        totalTokenUsage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    assert.ok(result.gaps.some((g) => g.name === "cache-write-input-tokens-nonzero"));
  });
});

// ===========================================================================
// T6 — session resolution priority + cwd boundary
// ===========================================================================

describe("T6 session resolution + cwd boundary", () => {
  it("CODEX_SESSION_ID glob hit does not fall back to --latest", () => {
    const target = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const decoy = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const targetFile = `rollout-2026-01-01T00-00-00-${target}.jsonl`;
    const decoyFile = `rollout-2026-01-01T00-00-00-${decoy}.jsonl`;
    const fixture = buildCodexFixture({
      filenames: {
        [targetFile]: [tokenCountEvent({ ts: "t0", item: "target session", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 })],
        [decoyFile]: [
          sessionMetaRecord({ sessionId: decoy, cwd: "/repo", ts: "t9" }),
          tokenCountEvent({ ts: "t9", item: "decoy latest session", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
        ],
      },
    });
    const result = readCodexSession({
      ...fixture,
      env: { CODEX_SESSION_ID: target },
      latest: true,
      cwdRoots: ["/repo"],
    });
    assert.equal(result.source, "exact");
    assert.equal(result.turns[0].item, "target session");
  });

  it("without CODEX_SESSION_ID, falls back to --latest and marks it non-precise", () => {
    const sessionId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const fixture = buildCodexFixture({
      filenames: {
        [filename]: [
          sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
          tokenCountEvent({ ts: "t1", item: "only session", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
        ],
      },
    });
    const result = readCodexSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.source, "latest-fallback");
    const md = renderMarkdownLedger(result, {});
    assert.ok(md.includes("非精準定位"));
  });

  it("excludes another repo's session and includes a .worktree/<name>/ session", () => {
    const other = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const wanted = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const otherFile = `rollout-2026-01-01T00-00-00-${other}.jsonl`;
    const wantedFile = `rollout-2026-01-01T00-00-00-${wanted}.jsonl`;
    const fixture = buildCodexFixture({
      filenames: {
        [otherFile]: [
          sessionMetaRecord({ sessionId: other, cwd: "/repo-foo/x", ts: "t0" }),
          tokenCountEvent({ ts: "t0", item: "other repo", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
        ],
        [wantedFile]: [
          sessionMetaRecord({ sessionId: wanted, cwd: "/repo/.worktree/add-per-session-usage-telemetry/x", ts: "t1" }),
          tokenCountEvent({ ts: "t1", item: "worktree session", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
        ],
      },
    });
    const result = readCodexSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    assert.equal(result.turns[0].item, "worktree session");
  });

  it("session-id whitelist: malformed values fail closed with zero readFile calls", () => {
    const badValues = ["../../../etc/passwd", "*", "a/b", " ", ""];
    for (const bad of badValues) {
      let readFileCalls = 0;
      const fixture = buildCodexFixture({ filenames: {} });
      const spyReadFile = (p) => {
        readFileCalls += 1;
        return fixture.readFile(p);
      };
      const result = readCodexSession({ ...fixture, readFile: spyReadFile, sessionId: bad });
      assert.equal(result.available, false, `expected fail-closed for ${JSON.stringify(bad)}`);
      assert.equal(typeof result.reason, "string");
      assert.equal(readFileCalls, 0, `expected zero readFile calls for ${JSON.stringify(bad)}`);
    }
  });

  it("cwd path-segment comparison: /repo-foo does not match root /repo; /repo/.worktree/x does", () => {
    const identity = (p) => p;
    assert.equal(matchesCwdRoots("/repo-foo/x", ["/repo"], identity), false);
    assert.equal(
      matchesCwdRoots("/repo/.worktree/add-per-session-usage-telemetry/x", ["/repo"], identity),
      true,
    );
  });
});

// ===========================================================================
// F-C1c — --latest discovery must not retain every candidate's content
// ===========================================================================
//
// Real hosts on this machine: ~9GB across 2665 Codex rollout files (largest
// 1.4GB) and 927MB across 1329 Claude Code transcripts. F-C1's directory-walk
// fix started actually finding real files for the first time (the old flat
// listing never found any), and F-I6 widened cwdRoots to every worktree of
// this repo — together these turned a previously-invisible "read+retain every
// candidate's full content just to peek at its cwd" pattern into a real OOM
// crash. The fix: probe only the first/last non-empty line of each candidate
// (bounded scan, no full-file split, no parseJsonl of the whole file) and
// never carry `content` forward in the candidates list — the winner is
// re-read once, for one extra full read total, not O(candidates) extra
// retained buffers.

describe("F-C1c --latest scan does not retain every candidate's content", () => {
  it("Codex: readFile is called at most (files + 1) times — one probe per file, one extra full read of the winner", () => {
    const wanted = "11111111-1111-1111-1111-111111111111";
    const filenames = {};
    for (let i = 0; i < 5; i += 1) {
      const decoy = `2222222${i}-2222-2222-2222-222222222222`;
      filenames[`rollout-2026-01-01T00-00-00-${decoy}.jsonl`] = [
        sessionMetaRecord({ sessionId: decoy, cwd: "/other-repo", ts: `t${i}` }),
        tokenCountEvent({ ts: `t${i}`, item: "decoy", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
      ];
    }
    filenames[`rollout-2026-01-01T00-00-00-${wanted}.jsonl`] = [
      sessionMetaRecord({ sessionId: wanted, cwd: "/repo", ts: "t9" }),
      tokenCountEvent({ ts: "t9", item: "wanted", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
    ];
    const fixture = buildCodexFixture({ filenames });
    let readFileCalls = 0;
    const spyReadFile = (p) => {
      readFileCalls += 1;
      return fixture.readFile(p);
    };
    const totalFiles = Object.keys(filenames).length;
    const result = readCodexSession({ ...fixture, readFile: spyReadFile, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    assert.equal(result.turns[0].item, "wanted");
    assert.equal(readFileCalls, totalFiles + 1, "expected exactly one probe read per candidate plus one extra full read of the winner");
  });

  it("Codex: a huge (multi-MB) decoy file's content does not leak into the result and is not the picked session", () => {
    const decoy = "33333333-3333-3333-3333-333333333333";
    const wanted = "44444444-4444-4444-4444-444444444444";
    // Simulate a large real rollout file: many turn_context/response_item
    // filler lines the scan must page past without allocating a full lines
    // array for the whole (~2MB) content.
    const filler = Array.from({ length: 20000 }, (_, i) => JSON.stringify({ type: "response_item", timestamp: `f${i}`, payload: { text: "x".repeat(80) } }));
    const decoyRecords = [sessionMetaRecord({ sessionId: decoy, cwd: "/other-repo", ts: "t0" }), ...filler.map((line) => JSON.parse(line))];
    const fixture = buildCodexFixture({
      filenames: {
        [`rollout-2026-01-01T00-00-00-${decoy}.jsonl`]: decoyRecords,
        [`rollout-2026-01-01T00-00-00-${wanted}.jsonl`]: [
          sessionMetaRecord({ sessionId: wanted, cwd: "/repo", ts: "t1" }),
          tokenCountEvent({ ts: "t1", item: "wanted, small", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
        ],
      },
    });
    const result = readCodexSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    assert.equal(result.session, wanted);
    assert.equal(result.turns[0].item, "wanted, small");
  });

  it("Codex: session_meta beyond the bounded scan window degrades to excluded, not a crash", () => {
    const buried = "55555555-5555-5555-5555-555555555555";
    const filler = Array.from({ length: 15 }, (_, i) => ({ type: "turn_context", timestamp: `f${i}` }));
    const records = [...filler, sessionMetaRecord({ sessionId: buried, cwd: "/repo", ts: "t0" })];
    const fixture = buildCodexFixture({ filenames: { [`rollout-2026-01-01T00-00-00-${buried}.jsonl`]: records } });
    const result = readCodexSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.available, false);
    assert.equal(result.reason, "no session found");
  });

  it("Claude Code: readFile is called at most (files + 1) times for --latest", () => {
    const filenamesRecords = {
      s1: [userRecord({ id: "u1", ts: "t0", cwd: "/other-repo", text: "hi" })],
      s2: [userRecord({ id: "u2", ts: "t0", cwd: "/other-repo", text: "hi" })],
      s3: [userRecord({ id: "u3", ts: "t9", cwd: "/repo", text: "wanted" })],
    };
    const root = "/claude-root";
    const projectDir = "proj";
    const files = {};
    const dirs = {
      [root]: ["projects"],
      [`${root}/projects`]: [projectDir],
      [`${root}/projects/${projectDir}`]: Object.keys(filenamesRecords).map((id) => `${id}.jsonl`),
    };
    for (const [id, records] of Object.entries(filenamesRecords)) {
      files[`${root}/projects/${projectDir}/${id}.jsonl`] = records.map((r) => JSON.stringify(r)).join("\n");
    }
    const listDir = (p) => fixturePathRequired(dirs, p);
    let readFileCalls = 0;
    const readFile = (p) => {
      readFileCalls += 1;
      return fixturePathRequired(files, p);
    };
    const result = readClaudeCodeSession({ root, listDir, readFile, realpath: (p) => p, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    assert.equal(result.turns[0].item, "wanted");
    assert.equal(readFileCalls, Object.keys(filenamesRecords).length + 1);
  });

  it("Claude Code: cwd found via bounded prefix scan when preceded by non-cwd-bearing lines (mirrors real queue-operation preamble)", () => {
    const root = "/claude-root";
    const projectDir = "proj";
    const sessionId = "s-with-preamble";
    const records = [
      { type: "queue-operation", timestamp: "t-2" },
      { type: "queue-operation", timestamp: "t-1" },
      userRecord({ id: "u1", ts: "t0", cwd: "/repo", text: "wanted after preamble" }),
    ];
    const content = records.map((r) => JSON.stringify(r)).join("\n");
    const files = { [`${root}/projects/${projectDir}/${sessionId}.jsonl`]: content };
    const dirs = {
      [root]: ["projects"],
      [`${root}/projects`]: [projectDir],
      [`${root}/projects/${projectDir}`]: [`${sessionId}.jsonl`],
    };
    const listDir = (p) => fixturePathRequired(dirs, p);
    const readFile = (p) => fixturePathRequired(files, p);
    const result = readClaudeCodeSession({ root, listDir, readFile, realpath: (p) => p, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    assert.equal(result.turns[0].item, "wanted after preamble");
  });
});

// ===========================================================================
// F-C1c — winning-file parse must not retain turn_context/response_item payloads
// ===========================================================================
//
// F-C1c's discovery-scan fix stopped retaining every candidate's content, but
// the winner is still fully parsed once. Generic parseJsonl retained every
// JSONL line — including turn_context/response_item conversation payloads
// that parseCodexTokenCountEvents never reads — and inflated a 218MB real
// rollout file to ~4GB peak heap. parseCodexJsonl streams line-by-line and
// only keeps session_meta / event_msg.

describe("F-C1c winning-file parse does not retain turn_context/response_item payloads", () => {
  it("parseCodexJsonl drops turn_context/response_item but keeps session_meta/event_msg and malformedCount", () => {
    const filler = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ type: "response_item", timestamp: `f${i}`, payload: { text: "x".repeat(200) } }));
    const content = [
      JSON.stringify(sessionMetaRecord({ sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cwd: "/repo", ts: "t0" })),
      ...filler,
      JSON.stringify({ type: "turn_context", timestamp: "t1", payload: { big: "y".repeat(500) } }),
      JSON.stringify(tokenCountEvent({ ts: "t2", item: "kept", input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 })),
      "{bad json",
    ].join("\n");
    const generic = parseJsonl(content);
    const filtered = parseCodexJsonl(content);
    assert.equal(generic.records.length, 5003, "generic parseJsonl retains every parseable line");
    assert.equal(filtered.records.length, 2, "parseCodexJsonl keeps only session_meta + event_msg");
    assert.equal(filtered.malformedCount, 1);
    assert.equal(filtered.records[0].type, "session_meta");
    assert.equal(filtered.records[1].payload.type, "token_count");
    assert.ok(filtered.records.every((r) => r.type === "session_meta" || r.type === "event_msg"));
  });

  it("Codex: readCodexSession still produces correct rows when the rollout file is mostly turn_context/response_item filler", () => {
    const sessionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const filler = Array.from({ length: 10000 }, (_, i) => ({ type: "response_item", timestamp: `f${i}`, payload: { text: "z".repeat(120) } }));
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      ...filler,
      { type: "turn_context", timestamp: "t1", payload: { context: "w".repeat(300) } },
      tokenCountEvent({
        ts: "t2",
        item: "survives filler",
        input_tokens: 42,
        cached_input_tokens: 0,
        output_tokens: 7,
        totalTokenUsage: { input_tokens: 42, cached_input_tokens: 0, output_tokens: 7 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId });
    assert.equal(result.available, true);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].item, "survives filler");
    assert.equal(result.turns[0].tokens.input, 42);
    assert.equal(result.turns[0].tokens.output, 7);
  });
});

// ===========================================================================
// T7 — renderMarkdownLedger
// ===========================================================================

describe("T7 renderMarkdownLedger", () => {
  function sampleResult() {
    return {
      available: true,
      host: "claude-code",
      session: "abc-123",
      source: "exact",
      cost_usd: 1.5,
      turns: [
        {
          ts: "2026-08-20T10:00:00.000Z",
          actor: "main",
          item: "do thing A",
          duration_ms: 1000,
          tokens: { input: 10, output: 100, cache_read: 50, cache_creation: 5, cache_read_peak: 60 },
          children: [],
        },
        {
          ts: "2026-08-20T10:01:00.000Z",
          actor: "main",
          item: "do thing B",
          duration_ms: 2000,
          tokens: { input: 20, output: 50, cache_read: 200, cache_creation: 0, cache_read_peak: 200 },
          children: [],
        },
      ],
      totals: { input: 30, output: 150, cache_read: 250, cache_creation: 5 },
      gaps: [],
      field_availability: {
        input: "available",
        output: "available",
        cache_creation: "available",
        cost_usd: "available",
        cache_read: "available",
      },
    };
  }

  it("table header is byte-exact to the D8 eight-column spec string", () => {
    const md = renderMarkdownLedger(sampleResult(), {});
    assert.ok(md.includes(TABLE_HEADER));
    assert.equal(TABLE_HEADER, "| 起 | 耗時 | 誰 | 項目 | input | output | cache_read | cache_creation |");
  });

  it("Usage source metadata is additive to existing reports", () => {
    const result = sampleResult();
    result.usage_source = "mixed-unresolved";
    result.usage_segments = [
      { source: "legacy-token-count", thread_attribution: "root", totals: { input: 10, output: 4, cache_read: 2 }, reconciliation: "legacy" },
      { source: "token-usage-record", thread_attribution: "root", segment_index: 1, totals: { input: 5, output: 3, cache_read: 1 }, reconciliation: "unverified" },
    ];
    result.usage_reconciliation = { status: "unverified" };
    result.usage_attribution = { status: "unverified", unassigned_response_count: 1, unknown_thread_event_count: 0 };

    const markdown = renderMarkdownLedger(result, {});

    assert.ok(markdown.includes("- source: 精準命中"));
    assert.ok(markdown.includes("- usage_source: mixed-unresolved"));
    assert.ok(markdown.includes("legacy-token-count/root:legacy(input=10,output=4,cache_read=2)"));
    assert.ok(markdown.includes("token-usage-record/root#1:unverified(input=5,output=3,cache_read=1)"));
    assert.ok(markdown.includes("- usage_reconciliation: unverified"));
    assert.ok(markdown.includes("- usage_attribution: unverified; unassigned_responses=1; unknown_thread_events=0"));
  });

  it("formats duration and token columns with en-US thousands separators", () => {
    const result = sampleResult();
    result.turns = [
      {
        ts: "2026-08-20T10:00:00.000Z",
        actor: "main",
        item: "long run",
        duration_ms: 7_726_700,
        tokens: { input: 149, output: 94_623, cache_read: 17_072_311, cache_creation: 417_582, cache_read_peak: 17_072_311 },
        children: [],
      },
    ];
    const md = renderMarkdownLedger(result, {});
    assert.ok(md.includes("| 7,726.7s |"), `expected formatted duration, got:\n${md}`);
    assert.ok(md.includes("| 94,623 |"));
    assert.ok(md.includes("| 17,072,311 |"));
    assert.ok(md.includes("| 417,582 |"));
    assert.ok(md.includes("cost_usd: $1.5"));
  });

  it("--sort output and --sort cache_read produce different row orders", () => {
    const byOutput = renderMarkdownLedger(sampleResult(), { sort: "output" });
    const byCacheRead = renderMarkdownLedger(sampleResult(), { sort: "cache_read" });
    assert.ok(byOutput.indexOf("do thing A") < byOutput.indexOf("do thing B"));
    assert.ok(byCacheRead.indexOf("do thing B") < byCacheRead.indexOf("do thing A"));
  });

  it("truncation footer reports shown/total/hidden counts", () => {
    const result = sampleResult();
    result.turns = Array.from({ length: 12 }, (_, i) => ({
      ts: `t${i}`,
      actor: "main",
      item: `turn ${i}`,
      duration_ms: i,
      tokens: { input: 1, output: 12 - i, cache_read: 1, cache_creation: 0, cache_read_peak: 1 },
      children: [],
    }));
    const md = renderMarkdownLedger(result, {});
    assert.ok(md.includes("顯示 10 / 共 12 列"));
    assert.ok(md.includes("未顯示 2 列"));
  });

  it("output is not a heading", () => {
    const md = renderMarkdownLedger(sampleResult(), {});
    assert.equal(/^#{1,6} /mu.test(md), false);
  });

  it("cache_read_peak is absent from markdown but present in --json-equivalent structure", () => {
    const result = sampleResult();
    const md = renderMarkdownLedger(result, {});
    assert.equal(/cache_read_peak/u.test(md), false);
    assert.ok(/cache_read_peak/u.test(JSON.stringify(result)));
  });
});

// ===========================================================================
// T8 — gaps + field_availability labels
// ===========================================================================

describe("T8 gaps + field_availability", () => {
  it("Codex: cost_usd unsupported-by-host, cache_creation unverified-on-host, input derived", () => {
    const filename = "rollout-2026-01-01T00-00-00-12121212-1212-1212-1212-121212121212.jsonl";
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 10,
        totalTokenUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "12121212-1212-1212-1212-121212121212" });
    assert.equal(result.field_availability.cost_usd, "unsupported-by-host");
    assert.equal(result.field_availability.cache_creation, "unverified-on-host");
    assert.equal(result.field_availability.input, "derived");
  });

  it("Claude Code: input is available", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" }),
      assistantRecord({ id: "m1", ts: "t1", input_tokens: 5 }),
    ];
    const fixture = buildClaudeCodeFixture({ sessionId: "13131313-1313-1313-1313-131313131313", records });
    const result = readClaudeCodeSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.field_availability.input, "available");
  });
});

// ===========================================================================
// T9 — thin CLI
// ===========================================================================

function captureConsoleLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

function writeClaudeCodeFixtureToDisk(root, sessionId, records) {
  const projectDir = path.join(root, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));
}

// F-I9(a): mirror the real nested sessions/<YYYY>/<MM>/<DD>/*.jsonl layout.
function writeCodexFixtureToDisk(root, sessionId, records) {
  const sessionsDir = path.join(root, "sessions", "2026", "01", "01");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(path.join(sessionsDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));
}

describe("T9 thin CLI", () => {
  it("host not found: stdout contains 'available: false', exit code 0", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-session-usage-"));
    try {
      let exitCode;
      const output = captureConsoleLog(() => {
        exitCode = reportCliMain(["--host", "claude-code"], {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: path.join(tmp, "does-not-exist"),
        });
      });
      assert.equal(exitCode, 0);
      assert.ok(output.includes("available: false"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--json output is valid JSON", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-session-usage-"));
    try {
      const sessionId = "14141414-1414-1414-1414-141414141414";
      const claudeRoot = path.join(tmp, "claude");
      writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
        userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" }),
        assistantRecord({ id: "m1", ts: "t1", output_tokens: 3, input_tokens: 2 }),
      ]);
      const output = captureConsoleLog(() => {
        reportCliMain(["--host", "claude-code", "--session", sessionId, "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
        });
      });
      const parsed = JSON.parse(output);
      assert.equal(parsed.available, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("D9 / task 15: --by-class --json adds a by_class field grouping user vs unsupported (no origin_class marker in this fixture)", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-session-usage-"));
    try {
      const sessionId = "15151515-1515-1515-1515-151515151515";
      const claudeRoot = path.join(tmp, "claude");
      writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
        userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" }),
        assistantRecord({ id: "m1", ts: "t1", output_tokens: 3, input_tokens: 2 }),
      ]);
      const output = captureConsoleLog(() => {
        reportCliMain(["--host", "claude-code", "--session", sessionId, "--json", "--by-class"], {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
        });
      });
      const parsed = JSON.parse(output);
      assert.equal(parsed.available, true);
      assert.equal(parsed.by_class.user.count, 1);
      assert.equal(parsed.by_class.user.tokens.output, 3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("D9 / task 15: --by-class text mode prints a by-class: summary line per class", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-session-usage-"));
    try {
      const sessionId = "16161616-1616-1616-1616-161616161616";
      const claudeRoot = path.join(tmp, "claude");
      writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
        userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" }),
        assistantRecord({ id: "m1", ts: "t1", output_tokens: 3, input_tokens: 2 }),
      ]);
      const output = captureConsoleLog(() => {
        reportCliMain(["--host", "claude-code", "--session", sessionId, "--by-class"], {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
        });
      });
      assert.match(output, /by-class:/);
      assert.match(output, /user: turns=1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--host auto with both hosts available prints two host= headers", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-session-usage-"));
    try {
      const claudeSessionId = "15151515-1515-1515-1515-151515151515";
      const codexSessionId = "16161616-1616-1616-1616-161616161616";
      const claudeRoot = path.join(tmp, "claude");
      const codexRoot = path.join(tmp, "codex");
      // --session is inherently host-specific (a single flag value cannot name a
      // session on both hosts at once), so --host auto's "both hosts have data"
      // path is exercised via --latest with matching cwd instead.
      writeClaudeCodeFixtureToDisk(claudeRoot, claudeSessionId, [
        userRecord({ id: "u1", ts: "t0", text: "hi", cwd: process.cwd() }),
        assistantRecord({ id: "m1", ts: "t1", output_tokens: 3, input_tokens: 2 }),
      ]);
      writeCodexFixtureToDisk(codexRoot, codexSessionId, [
        sessionMetaRecord({ sessionId: codexSessionId, cwd: process.cwd(), ts: "t0" }),
        tokenCountEvent({ ts: "t0", input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 }),
      ]);
      const output = captureConsoleLog(() => {
        reportCliMain(["--host", "auto", "--latest"], {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          DEVPRO_TEST_CODEX_ROOT: codexRoot,
        });
      });
      assert.ok(output.includes("host=claude-code"));
      assert.ok(output.includes("host=codex"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--rollup-manifests reports usage-manifest-missing for absent requested dispatches", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-rollup-cli-"));
    const evidenceRoot = path.join(tmp, "control-evidence");
    const dispatchId = "dispatch-41b8151c-650b-4a6b-bd1e-9143ab9dd894";
    try {
      writeUsageManifest({
        rootDir: evidenceRoot,
        manifest: {
          schema: USAGE_MANIFEST_SCHEMA,
          dispatch_id: dispatchId,
          attempt_id: "attempt-1",
          repository_slug: "owner/repo",
          head_ref_oid: "abc123",
          mode: "audit-only",
          review_target: "design",
          recorded_at: "2026-08-27T08:34:13.000Z",
          sessions: [{
            role: "tl-host",
            host: "codex",
            session_id: "11111111-1111-1111-1111-111111111111",
            source: "env",
          }],
          gaps: [],
        },
      });
      let exitCode;
      const output = captureConsoleLog(() => {
        exitCode = reportCliMain([
          "--rollup-manifests",
          "--control-evidence-root",
          evidenceRoot,
          "--dispatches",
          `${dispatchId},dispatch-missing-manifest`,
        ], {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: path.join(tmp, "claude"),
          DEVPRO_TEST_CODEX_ROOT: path.join(tmp, "codex"),
        });
      });
      assert.equal(exitCode, 0);
      assert.match(output, /usage-manifest-missing\(dispatch-missing-manifest\)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Retained manifest survives visible owner-TTL cleanup and is counted once", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-rollup-retained-manifest-"));
    const evidenceRoot = path.join(tmp, "control-evidence");
    const savedMarkerRoot = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = path.join(tmp, "post-pr-markers");
    const dispatchId = "dispatch-retained-usage-manifest";
    const dispatchRecord = {
      schema: "devpro-second-review-dispatch/v1",
      repository_slug: "owner/repo",
      pr_number: "none",
      head_ref_oid: "none",
      attempt_id: "attempt-retained-manifest",
      dispatch_id: dispatchId,
      previous_dispatch_id: null,
      packet_sha256: "a".repeat(64),
      carrier_root_id: "b".repeat(64),
    };
    try {
      await reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatchRecord });
      await claimDispatchInvocation({ rootDir: evidenceRoot, record: dispatchRecord });
      await writeCompletionReceipt({
        rootDir: evidenceRoot,
        record: {
          repository_slug: dispatchRecord.repository_slug,
          pr_number: dispatchRecord.pr_number,
          head_ref_oid: dispatchRecord.head_ref_oid,
          attempt_id: dispatchRecord.attempt_id,
          dispatch_id: dispatchRecord.dispatch_id,
          previous_dispatch_id: dispatchRecord.previous_dispatch_id,
          schema: COMPLETION_SCHEMA,
          outcome: "reviewer_process_closed_audit_only",
          classification: "audit_only_verified",
          process_close_observed: true,
        },
      });
      writeUsageManifest({
        rootDir: evidenceRoot,
        manifest: {
          schema: USAGE_MANIFEST_SCHEMA,
          dispatch_id: dispatchId,
          attempt_id: dispatchRecord.attempt_id,
          repository_slug: dispatchRecord.repository_slug,
          head_ref_oid: "abc123",
          mode: "audit-only",
          review_target: "design",
          recorded_at: "2026-09-01T00:00:00.000Z",
          sessions: [{
            role: "tl-host",
            host: "codex",
            session_id: "11111111-1111-1111-1111-111111111111",
            source: "fixture",
          }],
          gaps: [],
        },
      });
      const codexRoot = path.join(tmp, "codex");
      writeCodexFixtureToDisk(codexRoot, "11111111-1111-1111-1111-111111111111", [
        sessionMetaRecord({ sessionId: "11111111-1111-1111-1111-111111111111", cwd: "/repo", ts: "2026-01-01T00:00:00Z" }),
        tokenCountEvent({ ts: "2026-01-01T00:00:01Z", input_tokens: 30, cached_input_tokens: 10, output_tokens: 12 }),
      ]);

      const redAssertions = [];
      const beforeCleanup = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--control-evidence-root", evidenceRoot,
        "--dispatches", `${dispatchId},${dispatchId}`, "--json",
      ], { HOME: tmp, DEVPRO_TEST_CODEX_ROOT: codexRoot }));
      const beforeCleanupRollup = JSON.parse(beforeCleanup);
      if (beforeCleanupRollup.dispatches.length !== 1) {
        redAssertions.push(`visible and retained copies plus duplicate IDs produced ${beforeCleanupRollup.dispatches.length} rows`);
      }
      if (beforeCleanupRollup.arithmeticTotals.input !== 20 || beforeCleanupRollup.arithmeticTotals.output !== 12) {
        redAssertions.push("duplicate visible/retained dispatch copies changed the expected single-set totals");
      }

      const cleanup = await cleanupOwnedControlEvidence({
        rootDir: evidenceRoot,
        activeMarkers: [],
        now: Date.now() + COMPLETE_CHAIN_OWNER_TTL_MS + 1,
      });
      assert.equal(cleanup.cleanedDirectories, 1, JSON.stringify(cleanup));
      assert.equal(existsSync(path.join(evidenceRoot, dispatchId)), false);

      const output = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--control-evidence-root", evidenceRoot,
        "--dispatches", `${dispatchId},${dispatchId}`, "--json",
      ], {
        HOME: tmp,
        DEVPRO_TEST_CLAUDE_ROOT: path.join(tmp, "claude"),
        DEVPRO_TEST_CODEX_ROOT: codexRoot,
      }));
      const parsed = JSON.parse(output);
      if (parsed.dispatches.length !== 1) redAssertions.push(`retained lookup returned ${parsed.dispatches.length} rows`);
      if (parsed.dispatches[0]?.manifest.dispatch_id !== dispatchId) redAssertions.push("retained dispatch row was not found");
      if (parsed.arithmeticTotals.input !== 20 || parsed.arithmeticTotals.output !== 12) redAssertions.push("retained rollup totals differ from the single manifest totals");
      if (parsed.gaps.some((gap) => gap.name === "usage-manifest-missing")) redAssertions.push("retained lookup emitted usage-manifest-missing");

      const discovered = discoverUsageManifests({ rootDir: evidenceRoot });
      if (discovered.manifests.length !== 1) redAssertions.push(`unfiltered discovery returned ${discovered.manifests.length} manifests`);
      if (discovered.manifests[0]?.dispatch_id !== dispatchId) redAssertions.push("unfiltered discovery missed the retained dispatch");
      assert.deepEqual(redAssertions, [], redAssertions.join("; "));
    } finally {
      if (savedMarkerRoot === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
      else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = savedMarkerRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--rollup-manifests --json returns structured rollup payload", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-rollup-json-"));
    const evidenceRoot = path.join(tmp, "control-evidence");
    const dispatchId = "dispatch-41b8151c-650b-4a6b-bd1e-9143ab9dd894";
    try {
      writeUsageManifest({
        rootDir: evidenceRoot,
        manifest: {
          schema: USAGE_MANIFEST_SCHEMA,
          dispatch_id: dispatchId,
          attempt_id: "attempt-1",
          repository_slug: "owner/repo",
          head_ref_oid: "abc123",
          mode: "audit-only",
          review_target: "design",
          recorded_at: "2026-08-27T08:34:13.000Z",
          sessions: [],
          gaps: [{ name: "usage-manifest-missing", detail: "fixture gap" }],
        },
      });
      const output = captureConsoleLog(() => {
        reportCliMain([
          "--rollup-manifests",
          "--control-evidence-root",
          evidenceRoot,
          "--dispatch",
          dispatchId,
          "--json",
        ], { HOME: tmp });
      });
      const parsed = JSON.parse(output);
      assert.ok(Array.isArray(parsed.dispatches));
      assert.ok(parsed.arithmeticTotals);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Scenario: Rollup lineage preserves the dispatch reviewer usage source", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-rollup-reviewer-snapshot-"));
    const evidenceRoot = path.join(tmp, "control-evidence");
    const reviewerId = "91919191-9191-4191-8191-919191919191";
    const tlId = "92929292-9292-4292-8292-929292929292";
    const snapshot = {
      totals: { input: 75, output: 17, cache_read: 45, cache_creation: null },
      source: "reviewer-manifest:turn.completed.usage",
    };
    try {
      writeUsageManifest({
        rootDir: evidenceRoot,
        manifest: {
          schema: USAGE_MANIFEST_SCHEMA,
          dispatch_id: "dispatch-codex-reviewer-snapshot",
          attempt_id: "attempt-codex-reviewer-snapshot",
          repository_slug: "owner/repo",
          head_ref_oid: "abc123",
          mode: "audit-only",
          review_target: "design",
          recorded_at: "2026-09-01T00:00:00.000Z",
          sessions: [
            { role: "tl-host", host: "claude-code", session_id: tlId, source: "fixture" },
            { role: "reviewer", host: "codex", session_id: reviewerId, source: "fixture", usage_snapshot: snapshot },
          ],
          gaps: [],
        },
      });
      const env = {
        HOME: tmp,
        DEVPRO_TEST_CODEX_ROOT: path.join(tmp, "codex-unavailable"),
        DEVPRO_TEST_CLAUDE_ROOT: path.join(tmp, "claude-unavailable"),
      };
      const claudeRoot = path.join(tmp, "claude");
      writeClaudeCodeFixtureToDisk(claudeRoot, tlId, [
        userRecord({ id: "u-tl", ts: "2026-01-01T00:00:00.000Z", text: "tl", cwd: "/repo" }),
        assistantRecord({ id: "a-tl", ts: "2026-01-01T00:00:01.000Z", input_tokens: 3, output_tokens: 4 }),
      ]);
      env.DEVPRO_TEST_CLAUDE_ROOT = claudeRoot;
      const jsonOutput = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--control-evidence-root", evidenceRoot, "--json",
      ], env));
      const parsed = JSON.parse(jsonOutput);
      const usage = parsed.dispatches[0].sessions.find((session) => session.manifestSession.role === "reviewer").usage;
      const redAssertions = [];
      if (usage.available !== true) redAssertions.push("rollup snapshot fallback did not make reviewer usage available");
      if (JSON.stringify(usage.totals) !== JSON.stringify(snapshot.totals)) redAssertions.push("rollup reviewer totals differ from normalized snapshot");
      if (usage.reviewer_source !== "reviewer-manifest:turn.completed.usage") redAssertions.push("rollup reviewer source label is missing or incorrect");

      const markdown = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--control-evidence-root", evidenceRoot,
      ], env));
      for (const [pattern, label] of [
        [/reviewer-manifest:turn\.completed\.usage/, "rollup Markdown source"],
        [/input 75/, "rollup Markdown input"],
        [/output 17/, "rollup Markdown output"],
        [/cache_read 45/, "rollup Markdown cache_read"],
      ]) if (!pattern.test(markdown)) redAssertions.push(`${label} is missing`);

      const rollupLineageOutput = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--control-evidence-root", evidenceRoot, "--lineage", "--json",
      ], env));
      const rollupLineage = JSON.parse(rollupLineageOutput).lineage;
      const rollupLineageContributor = rollupLineage.contributors.find(
        (item) => item.role === "external-reviewer" && item.session_id === reviewerId,
      );
      if (rollupLineageContributor?.input !== 75) redAssertions.push("--rollup-manifests --lineage reviewer input snapshot is missing");
      if (rollupLineageContributor?.output !== 17) redAssertions.push("--rollup-manifests --lineage reviewer output snapshot is missing");
      if (rollupLineageContributor?.cache_read !== 45) redAssertions.push("--rollup-manifests --lineage reviewer cache_read snapshot is missing");
      if (rollupLineageContributor?.reviewer_source !== "reviewer-manifest:turn.completed.usage") redAssertions.push("--rollup-manifests --lineage reviewer source label is missing or incorrect");

      const rollupLineageMarkdown = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--lineage", "--control-evidence-root", evidenceRoot,
      ], env));
      for (const [pattern, label] of [
        [/reviewer-manifest:turn\.completed\.usage/, "rollup lineage Markdown source"],
        [/input 75/, "rollup lineage Markdown input"],
        [/output 17/, "rollup lineage Markdown output"],
        [/cache_read 45/, "rollup lineage Markdown cache_read"],
      ]) if (!pattern.test(rollupLineageMarkdown)) redAssertions.push(`${label} is missing`);

      withChangeUsageStateDir(() => {
        const changeName = "since-change-codex-reviewer-snapshot";
        const startTs = "2026-01-01T00:00:00.000Z";
        appendChangeUsageSession({
          changeName,
          session_id: tlId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: tlId, change_name: changeName, at: startTs });
        const lineageJson = captureConsoleLog(() => reportCliMain([
          "--since-change", changeName, "--lineage", "--json",
          "--control-evidence-root", evidenceRoot,
        ], env));
        const lineage = JSON.parse(lineageJson).lineage;
        if (lineage.counts.external_reviewer_sessions !== 1) redAssertions.push("lineage report did not attach the reviewer session");
        const contributor = lineage.contributors.find((item) => item.role === "external-reviewer");
        if (contributor?.input !== 75) redAssertions.push("lineage reviewer input snapshot is missing");
        if (contributor?.output !== 17) redAssertions.push("lineage reviewer output snapshot is missing");
        if (contributor?.cache_read !== 45) redAssertions.push("lineage reviewer cache_read snapshot is missing");
        if (contributor?.reviewer_source !== "reviewer-manifest:turn.completed.usage") redAssertions.push("lineage reviewer source label is missing or incorrect");

        const lineageMarkdown = captureConsoleLog(() => reportCliMain([
          "--since-change", changeName, "--lineage", "--control-evidence-root", evidenceRoot,
        ], env));
        for (const [pattern, label] of [
          [/reviewer-manifest:turn\.completed\.usage/, "lineage Markdown source"],
          [/input 75/, "lineage Markdown input"],
          [/output 17/, "lineage Markdown output"],
          [/cache_read 45/, "lineage Markdown cache_read"],
        ]) if (!pattern.test(lineageMarkdown)) redAssertions.push(`${label} is missing`);
      });

      const codexRoot = path.join(tmp, "codex-transcript-present");
      writeCodexFixtureToDisk(codexRoot, reviewerId, [
        sessionMetaRecord({ sessionId: reviewerId, cwd: "/repo", ts: "2026-01-01T00:00:00Z" }),
        tokenCountEvent({ ts: "2026-01-01T00:00:01Z", input_tokens: 30, cached_input_tokens: 10, output_tokens: 12 }),
      ]);
      const transcriptOutput = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--control-evidence-root", evidenceRoot, "--json",
      ], { ...env, DEVPRO_TEST_CODEX_ROOT: codexRoot }));
      const transcriptUsage = JSON.parse(transcriptOutput).dispatches[0].sessions
        .find((session) => session.manifestSession.role === "reviewer").usage;
      if (transcriptUsage.totals.input !== 20 || transcriptUsage.totals.output !== 12
        || transcriptUsage.source === "reviewer-manifest:turn.completed.usage") {
        redAssertions.push("available transcript did not remain authoritative over the snapshot");
      }
      if (transcriptUsage.reviewer_source !== "transcript") redAssertions.push("transcript provenance is missing");
      if (transcriptUsage.usage_source !== "legacy-token-count") redAssertions.push("Codex usage record format was not preserved separately from reviewer provenance");
      assert.deepEqual(redAssertions, [], redAssertions.join("; "));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Missing snapshot and Claude reviewer keep existing behavior", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-reviewer-snapshot-missing-"));
    const evidenceRoot = path.join(tmp, "control-evidence");
    const claudeId = "93939393-9393-4393-8393-939393939393";
    try {
      const manifestFor = (dispatchId, host, sessionId) => ({
        schema: USAGE_MANIFEST_SCHEMA,
        dispatch_id: dispatchId,
        attempt_id: `attempt-${dispatchId}`,
        repository_slug: "owner/repo",
        head_ref_oid: "abc123",
        mode: "audit-only",
        review_target: "design",
        recorded_at: "2026-09-01T00:00:00.000Z",
        sessions: [{ role: "reviewer", host, session_id: sessionId, source: "fixture" }],
        gaps: [],
      });
      writeUsageManifest({ rootDir: evidenceRoot, manifest: manifestFor("dispatch-codex-no-snapshot", "codex", "94949494-9494-4494-8494-949494949494") });
      writeUsageManifest({ rootDir: evidenceRoot, manifest: manifestFor("dispatch-claude-no-snapshot", "claude-code", claudeId) });
      const claudeRoot = path.join(tmp, "claude");
      writeClaudeCodeFixtureToDisk(claudeRoot, claudeId, [
        userRecord({ id: "u-claude", ts: "2026-01-01T00:00:00Z", text: "review", cwd: "/repo" }),
        assistantRecord({ id: "a-claude", ts: "2026-01-01T00:00:01Z", input_tokens: 8, output_tokens: 13 }),
      ]);
      const output = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--control-evidence-root", evidenceRoot, "--json",
      ], {
        HOME: tmp,
        DEVPRO_TEST_CODEX_ROOT: path.join(tmp, "codex-unavailable"),
        DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      }));
      const parsed = JSON.parse(output);
      assert.ok(parsed.gaps.some((gap) => gap.name === "manifest-session-unavailable" && gap.detail.includes("94949494")));
      const claudeUsage = parsed.dispatches.find((dispatch) => dispatch.manifest.dispatch_id === "dispatch-claude-no-snapshot")
        .sessions[0].usage;
      assert.equal(claudeUsage.available, true);
      assert.equal(claudeUsage.totals.input, 8);
      assert.equal(claudeUsage.totals.output, 13);
      assert.notEqual(claudeUsage.source, "reviewer-manifest:turn.completed.usage");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Available transcript remains authoritative over the manifest snapshot", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-reviewer-transcript-precedence-"));
    const evidenceRoot = path.join(tmp, "control-evidence");
    const reviewerId = "95959595-9595-4595-8595-959595959595";
    try {
      writeUsageManifest({
        rootDir: evidenceRoot,
        manifest: {
          schema: USAGE_MANIFEST_SCHEMA,
          dispatch_id: "dispatch-reviewer-transcript-precedence",
          attempt_id: "attempt-reviewer-transcript-precedence",
          repository_slug: "owner/repo",
          head_ref_oid: "abc123",
          mode: "audit-only",
          review_target: "design",
          recorded_at: "2026-09-01T00:00:00.000Z",
          sessions: [{
            role: "reviewer", host: "codex", session_id: reviewerId, source: "fixture",
            usage_snapshot: {
              totals: { input: 75, output: 17, cache_read: 45, cache_creation: null },
              source: "reviewer-manifest:turn.completed.usage",
            },
          }],
          gaps: [],
        },
      });
      const codexRoot = path.join(tmp, "codex");
      writeCodexFixtureToDisk(codexRoot, reviewerId, [
        sessionMetaRecord({ sessionId: reviewerId, cwd: "/repo", ts: "2026-01-01T00:00:00Z" }),
        tokenCountEvent({ ts: "2026-01-01T00:00:01Z", input_tokens: 30, cached_input_tokens: 10, output_tokens: 12 }),
      ]);
      const output = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--control-evidence-root", evidenceRoot, "--json",
      ], { HOME: tmp, DEVPRO_TEST_CODEX_ROOT: codexRoot }));
      const usage = JSON.parse(output).dispatches[0].sessions[0].usage;
      assert.equal(usage.totals.input, 20);
      assert.equal(usage.totals.output, 12);
      assert.equal(usage.reviewer_source, "transcript");
      assert.equal(usage.usage_source, "legacy-token-count");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--by-class with --rollup-manifests: exit code 2 (usage error, same treatment as --by-class with --since-change), never a silent exit-0 drop of --by-class", () => {
    // Same shape as the --since-change guard above: the manifest rollup
    // aggregates per-dispatch/per-session totals across a control-evidence
    // tree — it has no per-turn data for groupTurnsByClass either. Before
    // this fix, this combination fell through to the rollup branch's own
    // early returns (json / no-manifests-found / markdown render), all
    // before any by_class check, so it could silently render a rollup (or
    // silently report "no manifests found") without ever mentioning
    // --by-class was ignored.
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-rollup-byclass-rejected-"));
    const evidenceRoot = path.join(tmp, "control-evidence");
    try {
      let exitCode;
      const output = captureConsoleLog(() => {
        exitCode = reportCliMain(
          ["--rollup-manifests", "--control-evidence-root", evidenceRoot, "--by-class"],
          { HOME: tmp },
        );
      });
      assert.equal(exitCode, 2);
      assert.equal(
        output.includes("usage-manifest rollup"),
        false,
        "must reject before touching manifest discovery, not silently roll up without by_class",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("T7-T9 lineage CLI and evidence boundary", () => {
  function writeLineageCodexPair(codexRoot, rootId, childId, { childSpawns = false } = {}) {
    writeCodexFixtureToDisk(codexRoot, rootId, [
      { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: rootId, cwd: process.cwd() } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ agent_type: "dp-programmer" }) } },
      tokenCountEvent({
        ts: "2026-01-01T00:00:02Z",
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 5,
        totalTokenUsage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      }),
    ]);
    writeCodexFixtureToDisk(codexRoot, childId, [
      {
        timestamp: "2026-01-01T00:10:00Z",
        type: "session_meta",
        payload: { id: childId, cwd: process.cwd(), source: { subagent: { thread_spawn: { parent_thread_id: rootId } } } },
      },
      ...(childSpawns
        ? [{
            timestamp: "2026-01-01T00:10:00.500Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "spawn_agent",
              arguments: JSON.stringify({ agent_type: "dp-programmer" }),
            },
          }]
        : []),
      tokenCountEvent({
        ts: "2026-01-01T00:10:01Z",
        input_tokens: 7,
        cached_input_tokens: 0,
        output_tokens: 3,
        totalTokenUsage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3 },
      }),
    ]);
  }

  it("--lineage JSON preserves legacy fields and adds the versioned claim dimensions", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-lineage-cli-"));
    try {
      const rootId = "41414141-4141-4141-8141-414141414141";
      const childId = "42424242-4242-4242-8242-424242424242";
      const codexRoot = path.join(tmp, "codex");
      writeLineageCodexPair(codexRoot, rootId, childId);
      const output = captureConsoleLog(() => {
        const exitCode = reportCliMain(["--host", "codex", "--session", rootId, "--lineage", "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CODEX_ROOT: codexRoot,
        });
        assert.equal(exitCode, 0);
      });
      const parsed = JSON.parse(output);
      assert.equal(parsed.available, true);
      assert.ok(parsed.totals);
      assert.equal(parsed.lineage.schema, "devpro-lineage-usage-report/v1");
      assert.equal(parsed.lineage.claim.lookup, "exact");
      assert.equal(parsed.lineage.claim.scope, "session-wide");
      assert.equal(parsed.lineage.claim.coverage, "lineage-complete");
      assert.equal(parsed.lineage.claim.terminality, "unknown");
      assert.equal(parsed.lineage.counts.root_sessions, 1);
      assert.equal(parsed.lineage.counts.descendant_sessions, 1);
      assert.equal(parsed.lineage.metrics.observed_tokens.lineage_inclusive, 25);
      assert.ok(!parsed.lineage.claim.claims.includes("final"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // I-06 (PR #2473 second cross-model round): `--since-change` populates a
  // checkpoint usage override for every session it aggregates, and the Codex
  // adapter read `spawn_events` / `spawn_observability` from the override-aware
  // reader — one line above its own comment saying an override never carries that
  // evidence. Every override therefore yielded `spawn_events ?? 0` and a
  // non-"complete" observability, so the exact mode this change built for Codex
  // spawn observability was the one mode that always reported it degraded.
  it("(I-06) --since-change --lineage keeps Codex spawn observability: a checkpoint override is not spawn evidence", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-lineage-codex-spawn-"));
      try {
        const changeName = "since-lineage-codex-spawn";
        const rootId = "43434343-4343-4343-8343-434343434343";
        const childId = "44444444-4444-4444-8444-444444444444";
        const codexRoot = path.join(tmp, "codex");
        writeLineageCodexPair(codexRoot, rootId, childId);

        const direct = JSON.parse(captureConsoleLog(() => reportCliMain(["--host", "codex", "--session", rootId, "--lineage", "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CODEX_ROOT: codexRoot,
        })));
        assert.equal(direct.lineage.claim.coverage, "lineage-complete", "baseline: without an override the same tree is complete");

        appendChangeUsageSession({
          changeName,
          session_id: rootId,
          start_ts: "2026-01-01T00:00:00.000Z",
          host: "codex",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: rootId, change_name: changeName, at: "2026-01-01T00:00:00.000Z" });
        const scoped = JSON.parse(captureConsoleLog(() => reportCliMain(["--since-change", changeName, "--lineage", "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CODEX_ROOT: codexRoot,
        })));
        assert.deepEqual(
          (scoped.lineage.gaps ?? []).filter((gap) => gap.name === "codex-spawn-observability-unverified"),
          [],
          "the checkpoint override must not manufacture a spawn-observability gap",
        );
        assert.equal(scoped.lineage.claim.coverage, "lineage-complete", "the same tree stays complete under --since-change");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("--lineage Markdown uses the exact D8 structured vocabulary", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-lineage-markdown-"));
    try {
      const rootId = "43434343-4343-4343-8343-434343434343";
      const childId = "44444444-4444-4444-8444-444444444444";
      const codexRoot = path.join(tmp, "codex");
      writeLineageCodexPair(codexRoot, rootId, childId);
      const output = captureConsoleLog(() => reportCliMain(["--host", "codex", "--session", rootId, "--lineage"], {
        HOME: tmp,
        DEVPRO_TEST_CODEX_ROOT: codexRoot,
      }));
      for (const field of [
        "schema", "lookup", "scope", "coverage", "terminality", "reconciliation", "claims",
        "root_sessions", "descendant_sessions", "external_reviewer_sessions", "dispatch_rows", "spawn_events",
        "root_totals", "descendant_totals", "external_reviewer_totals", "lineage_totals",
        "efficiency_verdict", "baseline", "quota_impact", "quota_authority", "gaps",
      ]) assert.match(output, new RegExp(`- ${field}:`));
      assert.match(output, /- lineage_totals: input 17 \/ output 8/);
      assert.doesNotMatch(output, /reproduced.*claims|claims:.*reproduced/);
      const recapCheck = hasTokenSpendRecord(`## Token 回顧\n${output}\n\n## 版本資訊\nRules: test`);
      assert.equal(recapCheck.valid, true, recapCheck.reason);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--lineage names a missing Codex descendant instead of vacuously claiming complete", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-lineage-missing-child-"));
    try {
      const rootId = "52525252-5252-4252-8252-525252525252";
      const codexRoot = path.join(tmp, "codex");
      writeCodexFixtureToDisk(codexRoot, rootId, [
        { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: rootId, cwd: process.cwd() } },
        { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ agent_type: "dp-programmer" }) } },
        tokenCountEvent({
          ts: "2026-01-01T00:00:02Z",
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
          totalTokenUsage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
        }),
      ]);
      const output = captureConsoleLog(() => reportCliMain(["--host", "codex", "--session", rootId, "--lineage", "--json"], {
        HOME: tmp,
        DEVPRO_TEST_CODEX_ROOT: codexRoot,
      }));
      const parsed = JSON.parse(output);
      assert.equal(parsed.lineage.claim.coverage, "lineage-incomplete");
      assert.ok(parsed.lineage.gaps.some((gap) => gap.name === "codex-descendant-usage-missing"));
      assert.ok(!parsed.lineage.claim.claims.includes("lineage-complete"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--lineage recursively rejects a missing grandchild spawned by a discovered Codex child", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-lineage-missing-grandchild-"));
    try {
      const rootId = "56565656-5656-4656-8656-565656565656";
      const childId = "57575757-5757-4757-8757-575757575757";
      const codexRoot = path.join(tmp, "codex");
      writeLineageCodexPair(codexRoot, rootId, childId, { childSpawns: true });

      const output = captureConsoleLog(() => reportCliMain(
        ["--host", "codex", "--session", rootId, "--lineage", "--json"],
        { HOME: tmp, DEVPRO_TEST_CODEX_ROOT: codexRoot },
      ));
      const parsed = JSON.parse(output);

      assert.equal(parsed.lineage.counts.root_sessions, 1);
      assert.equal(parsed.lineage.counts.descendant_sessions, 1);
      assert.equal(parsed.lineage.counts.spawn_events, 2);
      assert.equal(parsed.lineage.claim.coverage, "lineage-incomplete");
      assert.ok(parsed.lineage.gaps.some(
        (gap) => gap.name === "codex-descendant-usage-missing" && gap.identity === `codex:${childId}`,
      ));
      assert.ok(!parsed.lineage.claim.claims.includes("lineage-complete"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--lineage uses a verified Claude direct-subagent relationship in the production adapter", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-lineage-claude-direct-"));
    try {
      const rootId = "53535353-5353-4353-8353-535353535353";
      const childId = "54545454-5454-4454-8454-545454545454";
      const toolUseId = "toolu_verified_lineage";
      const claudeRoot = path.join(tmp, "claude");
      writeClaudeCodeFixtureToDisk(claudeRoot, rootId, [
        userRecord({ id: "u-root", ts: "2026-01-01T00:00:00Z", text: "redacted", cwd: process.cwd() }),
        assistantRecord({
          id: "a-root",
          ts: "2026-01-01T00:00:01Z",
          input_tokens: 2,
          output_tokens: 5,
          toolUseId,
        }),
      ]);
      const subagentsDir = path.join(claudeRoot, "projects", "proj", rootId, "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(path.join(subagentsDir, `agent-${childId}.meta.json`), JSON.stringify({
        toolUseId,
        agentType: "dp-programmer",
        description: "redacted fixture",
        contextMode: "fresh",
      }));
      writeFileSync(path.join(subagentsDir, `agent-${childId}.jsonl`), JSON.stringify(assistantRecord({
        id: "a-child",
        ts: "2026-01-01T00:00:02Z",
        input_tokens: 3,
        output_tokens: 7,
      })));

      const output = captureConsoleLog(() => reportCliMain(
        ["--host", "claude-code", "--session", rootId, "--lineage", "--json"],
        { HOME: tmp, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot },
      ));
      const parsed = JSON.parse(output);
      assert.equal(parsed.totals.input, 5, "legacy aggregate continues to include direct subagent usage");
      assert.equal(parsed.totals.output, 12);
      assert.equal(parsed.lineage.counts.descendant_sessions, 1);
      assert.equal(parsed.lineage.metrics.input.root, 2);
      assert.equal(parsed.lineage.metrics.input.descendants, 3);
      assert.equal(parsed.lineage.metrics.output.root, 5);
      assert.equal(parsed.lineage.metrics.output.descendants, 7);
      assert.equal(parsed.lineage.contributors.find((item) => item.role === "descendant")?.context_mode, "fresh");
      assert.ok(!parsed.lineage.gaps.some((gap) => gap.name === "claude-context-mode-unknown"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--budget-check with --lineage rejects before checkpoint evaluation with exit 2", () => {
    let exitCode;
    captureConsoleLog(() => {
      exitCode = reportCliMain(["--since-change", "must-not-read", "--budget-check", "--lineage"], { HOME: "/nonexistent" });
    });
    assert.equal(exitCode, 2);
  });

  it("--rollup-manifests --lineage expands unique TL roots and keeps dispatch rows separate from reviewer sessions", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-lineage-rollup-"));
    try {
      const rootId = "47474747-4747-4747-8747-474747474747";
      const childId = "48484848-4848-4848-8484-484848484848";
      const reviewerOne = "49494949-4949-4949-8494-494949494949";
      const reviewerTwo = "50505050-5050-4050-8050-505050505050";
      const codexRoot = path.join(tmp, "codex");
      const claudeRoot = path.join(tmp, "claude");
      const evidenceRoot = path.join(tmp, "control-evidence");
      writeLineageCodexPair(codexRoot, rootId, childId);
      for (const reviewer of [reviewerOne, reviewerTwo]) {
        writeClaudeCodeFixtureToDisk(claudeRoot, reviewer, [
          userRecord({ id: `u-${reviewer}`, ts: "2026-01-01T00:00:00Z", text: "review", cwd: process.cwd() }),
          assistantRecord({ id: `a-${reviewer}`, ts: "2026-01-01T00:00:01Z", input_tokens: 2, output_tokens: 3 }),
        ]);
      }
      for (const [index, reviewer] of [reviewerOne, reviewerTwo, reviewerOne].entries()) {
        writeUsageManifest({
          rootDir: evidenceRoot,
          manifest: {
            schema: USAGE_MANIFEST_SCHEMA,
            dispatch_id: `dispatch-lineage-${index}`,
            paged_coverage: { planned_window_count: 3, invoked_window_count: index === 0 ? 2 : 1, invoked_windows: [
              { index: 1, host: "claude-code", session_id: reviewer }, ...(index === 0 ? [{ index: 2, host: null, session_id: null }] : []),
            ] },
            attempt_id: `attempt-${index}`,
            repository_slug: "owner/repo",
            head_ref_oid: "abc123",
            mode: "audit-only",
            review_target: "local-diff",
            recorded_at: `2026-01-01T00:00:0${index}.000Z`,
            sessions: [
              { role: "tl-host", host: "codex", session_id: rootId, source: "fixture" },
              { role: "reviewer", host: "claude-code", session_id: reviewer, source: "fixture" },
            ],
            gaps: [],
          },
        });
      }
      const output = captureConsoleLog(() => reportCliMain([
        "--rollup-manifests", "--control-evidence-root", evidenceRoot, "--lineage", "--json",
      ], {
        HOME: tmp,
        DEVPRO_TEST_CODEX_ROOT: codexRoot,
        DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      }));
      const parsed = JSON.parse(output);
      assert.equal(parsed.lineage.counts.root_sessions, 1);
      assert.equal(parsed.lineage.counts.descendant_sessions, 1);
      assert.equal(parsed.lineage.counts.external_reviewer_sessions, 2);
      assert.equal(parsed.lineage.counts.dispatch_rows, 3);
      assert.equal(parsed.coverage_status, "partial");
      assert.ok(parsed.lineage.gaps.some(gap => gap.name === "reviewer-window-session-missing"));
      assert.equal(parsed.lineage.claim.coverage, "lineage-incomplete");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const scenario of ["modern", "legacy", "partial", "zero"]) {
    it(`F2 coverage CLI distinguishes ${scenario} for rollup and since-change`, () => {
      withChangeUsageStateDir(() => {
        const tmp = mkdtempSync(path.join(tmpdir(), "devpro-coverage-polarity-"));
        try {
          const rootId = "47474747-4747-4747-8747-474747474747";
          const childId = "48484848-4848-4848-8484-484848484848";
          const reviewerId = "49494949-4949-4949-8494-494949494949";
          const codexRoot = path.join(tmp, "codex");
          const claudeRoot = path.join(tmp, "claude");
          const evidenceRoot = path.join(tmp, "control-evidence");
          writeLineageCodexPair(codexRoot, rootId, childId);
          writeClaudeCodeFixtureToDisk(claudeRoot, reviewerId, [
            userRecord({ id: "u-review", ts: "2026-01-01T00:00:00Z", text: "review", cwd: process.cwd() }),
            assistantRecord({ id: "a-review", ts: "2026-01-01T00:00:01Z", input_tokens: 2, output_tokens: 3 }),
          ]);
          if (scenario !== "zero") writeUsageManifest({ rootDir: evidenceRoot, manifest: {
            schema: USAGE_MANIFEST_SCHEMA, dispatch_id: "dispatch-coverage-polarity", attempt_id: "attempt-coverage",
            mode: "audit-only", review_target: "local-diff", repository_slug: "owner/repo", head_ref_oid: "abc123",
            sessions: [{ role: "tl-host", host: "codex", session_id: rootId }, { role: "reviewer", host: "claude-code", session_id: reviewerId }],
            gaps: scenario === "modern" ? [{ detail: "gap without name" }, { name: 42 }] : [], ...(scenario === "legacy" ? {} : { paged_coverage: { planned_window_count: 1,
              invoked_window_count: 1, invoked_windows: [{ index: 1, host: scenario === "partial" ? null : "claude-code", session_id: scenario === "partial" ? null : reviewerId }] } }),
          } });
          const env = { HOME: tmp, DEVPRO_TEST_CODEX_ROOT: codexRoot, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot };
          const historicalPath = path.join(evidenceRoot, "dispatch-coverage-polarity", "usage-manifest.json");
          const historicalBytes = scenario === "legacy" ? readFileSync(historicalPath, "utf8") : null;
          const rollup = JSON.parse(captureConsoleLog(() => reportCliMain([
            "--rollup-manifests", "--lineage", "--json", "--control-evidence-root", evidenceRoot,
          ], env)));
          assert.equal(rollup.coverage_status, scenario === "legacy" ? "unknown" : scenario === "partial" ? "partial" : "complete");
          const expectedGap = scenario === "legacy" ? "reviewer-window-coverage-unknown" : scenario === "partial" ? "reviewer-window-session-missing" : null;
          assert.equal(rollup.lineage.gaps.some(gap => typeof gap?.name === "string" && gap.name.startsWith("reviewer-window-")), expectedGap !== null);
          if (expectedGap) assert.ok(rollup.lineage.gaps.some(gap => gap.name === expectedGap));
          assert.equal(rollup.lineage.claim.coverage, scenario === "modern" ? "lineage-complete" : "lineage-incomplete");
          if (scenario === "zero") assert.ok(rollup.lineage.gaps.some(gap => gap.name === "lineage-root-unavailable"), "usage true-zero does not invent measurement roots");
          const changeName = "coverage-polarity";
          appendChangeUsageSession({ changeName, session_id: rootId, start_ts: "2026-01-01T00:00:00.000Z", host: "codex", session_pending_line_count_at_start: 0, tasks_line_count_at_start: 0 });
          recordSessionChangeTransition({ session_id: rootId, change_name: changeName, at: "2026-01-01T00:00:00.000Z" });
          const scoped = JSON.parse(captureConsoleLog(() => reportCliMain([
            "--since-change", changeName, "--lineage", "--json", "--control-evidence-root", evidenceRoot,
          ], env)));
          assert.equal(scoped.lineage.claim.coverage, expectedGap ? "lineage-incomplete" : "lineage-complete");
          if (expectedGap) {
            assert.ok(scoped.lineage.gaps.some(gap => gap.name === expectedGap));
            assert.ok(!scoped.lineage.claim.claims.includes("lineage-complete"));
          } else assert.ok(!scoped.lineage.gaps.some(gap => typeof gap?.name === "string" && gap.name.startsWith("reviewer-window-")));
          if (scenario === "legacy") assert.equal(readFileSync(historicalPath, "utf8"), historicalBytes, "unknown is derived without rewriting historical evidence");
        } finally { rmSync(tmp, { recursive: true, force: true }); }
      });
    });
  }

  it("--evidence-boundary reproduces fixed arithmetic, sanitizes source path, and reports drift without exit 2", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-boundary-cli-"));
    try {
      const rootId = "45454545-4545-4545-8545-454545454545";
      const childId = "46464646-4646-4646-8464-464646464646";
      const codexRoot = path.join(tmp, "codex");
      writeLineageCodexPair(codexRoot, rootId, childId);
      const boundaryPath = path.join(tmp, "redacted-boundary.json");
      const boundary = {
        schema: "devpro-lineage-evidence-boundary/v1",
        scope: "mixed-session",
        generated_at: "2026-01-01T01:00:00Z",
        roots: [{ host: "codex", session_id: rootId }],
        external_sessions: [],
        observed_through: "2026-01-01T01:00:00Z",
        closed_at: "2026-01-01T01:00:00Z",
        terminality_evidence: "redacted-fixture",
        expected: {
          identity_digest_sha256: "4906c568eecb38752b2f8a6938565a0103920c9047164a3cc2fb9f047a150a56",
          counts: { root_sessions: 1, descendant_sessions: 1, external_reviewer_sessions: 0, dispatch_rows: 0 },
          metrics: { root_observed_tokens: 15, descendant_observed_tokens: 10, external_reviewer_observed_tokens: 0, lineage_observed_tokens: 25 },
        },
      };
      boundary.boundary_digest = digestEvidenceBoundary(boundary);
      writeFileSync(boundaryPath, JSON.stringify(boundary));
      let exitCode;
      const reproducedOutput = captureConsoleLog(() => {
        exitCode = reportCliMain(["--evidence-boundary", boundaryPath, "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CODEX_ROOT: codexRoot,
        });
      });
      assert.equal(exitCode, 0);
      const reproduced = JSON.parse(reproducedOutput);
      assert.equal(reproduced.evidence_status, "reproduced");
      assert.equal(reproduced.claim.terminality, "terminal");
      assert.equal(reproduced.measurement_boundary.source, "redacted-boundary.json");
      assert.ok(reproduced.measurement_boundary.digest);
      assert.ok(!reproducedOutput.includes(tmp));
      assert.ok(!reproduced.claim.claims.includes("reproduced"));

      boundary.expected.metrics.lineage_observed_tokens = 26;
      writeFileSync(boundaryPath, JSON.stringify(boundary));
      const driftOutput = captureConsoleLog(() => {
        exitCode = reportCliMain(["--evidence-boundary", boundaryPath, "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CODEX_ROOT: codexRoot,
        });
      });
      assert.equal(exitCode, 0);
      const drift = JSON.parse(driftOutput);
      assert.equal(drift.evidence_status, "drift");
      assert.ok(drift.gaps.some((gap) => gap.name === "evidence-boundary-drift"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// T10 — `--since-change` aggregation
// (design.md D7 — round 4 finding F-4-1, round 5 findings F-5-1/F-5-2,
// round 6 finding F-6-2)
// ===========================================================================

function withChangeUsageStateDir(fn) {
  const dir = makeTempDir("devpro-since-change-state-");
  const previous = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
  process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = previous;
  }
}

describe("T10 --since-change aggregation", () => {
  it("(a) single fully-resolvable session: coverage complete; usage = turns AFTER start_ts, strictly less than the session's unfiltered totals", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-a-"));
      try {
        const changeName = "since-change-a";
        const sessionId = "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0";
        const startTs = "2026-01-01T01:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: "2026-01-01T00:00:00.000Z", text: "before start_ts", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 100 }),
          userRecord({ id: "u2", ts: "2026-01-01T02:00:00.000Z", text: "after start_ts", cwd: "/repo" }),
          assistantRecord({ id: "m2", ts: "2026-01-01T02:00:01.000Z", output_tokens: 50 }),
        ]);
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: sessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs }).status,
          "written",
        );

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName, "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.available, true);
        assert.equal(parsed.coverage, "complete");
        assert.equal(parsed.totals.output, 50, "must only count the turn AFTER start_ts");
        assert.ok(parsed.totals.output < 150, "must be strictly less than the unfiltered session total (100 + 50)");
        assert.equal(parsed.sessions.length, 1);
        assert.equal(parsed.sessions[0].status, "ok");
        assert.equal(parsed.sessions[0].totals.output, 50);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("--since-change --lineage uses bounded checkpoint totals and marks the current snapshot open", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-lineage-"));
      try {
        const changeName = "since-lineage";
        const sessionId = "51515151-5151-4151-8151-515151515151";
        const startTs = "2026-01-01T01:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u-before", ts: "2026-01-01T00:00:00.000Z", text: "before", cwd: "/repo" }),
          assistantRecord({ id: "a-before", ts: "2026-01-01T00:00:01.000Z", output_tokens: 100 }),
          userRecord({ id: "u-after", ts: "2026-01-01T02:00:00.000Z", text: "after", cwd: "/repo" }),
          assistantRecord({ id: "a-after", ts: "2026-01-01T02:00:01.000Z", output_tokens: 50 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });
        const output = captureConsoleLog(() => reportCliMain(["--since-change", changeName, "--lineage", "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
        }));
        const parsed = JSON.parse(output);
        assert.equal(parsed.totals.output, 50);
        assert.equal(parsed.lineage.metrics.output.root, 50);
        assert.equal(parsed.lineage.claim.scope, "current-change");
        assert.equal(parsed.lineage.claim.terminality, "open");
        assert.ok(parsed.lineage.claim.claims.includes("current-change"));
        assert.ok(!parsed.lineage.claim.claims.includes("final"));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("R5: --since-change --lineage attaches same-change reviewer manifest (not false zero)", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-lineage-reviewer-"));
      try {
        const changeName = "since-lineage-reviewer";
        const tlId = "61616161-6161-4161-8161-616161616161";
        const reviewerId = "62626262-6262-4262-8262-626262626262";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        const evidenceRoot = path.join(tmp, "control-evidence");
        writeClaudeCodeFixtureToDisk(claudeRoot, tlId, [
          userRecord({ id: "u-tl", ts: startTs, text: "tl", cwd: "/repo" }),
          assistantRecord({ id: "a-tl", ts: "2026-01-01T00:00:01.000Z", output_tokens: 4 }),
        ]);
        writeClaudeCodeFixtureToDisk(claudeRoot, reviewerId, [
          userRecord({ id: "u-rev", ts: startTs, text: "review", cwd: "/repo" }),
          assistantRecord({ id: "a-rev", ts: "2026-01-01T00:00:01.000Z", input_tokens: 2, output_tokens: 9 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: tlId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: tlId, change_name: changeName, at: startTs });
        writeUsageManifest({
          rootDir: evidenceRoot,
          manifest: {
            schema: USAGE_MANIFEST_SCHEMA,
            dispatch_id: "dispatch-r5-reviewer",
            attempt_id: "attempt-r5",
            repository_slug: "owner/repo",
            head_ref_oid: "abc123",
            mode: "pr-sticky",
            review_target: "PR #1",
            recorded_at: "2026-01-01T00:00:00.000Z",
            sessions: [
              { role: "tl-host", host: "claude-code", session_id: tlId, source: "fixture" },
              { role: "reviewer", host: "claude-code", session_id: reviewerId, source: "fixture" },
            ],
            gaps: [],
          },
        });
        const output = captureConsoleLog(() => reportCliMain([
          "--since-change", changeName, "--lineage", "--json",
          "--control-evidence-root", evidenceRoot,
        ], {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
        }));
        const parsed = JSON.parse(output);
        const external = parsed.lineage.counts.external_reviewer_sessions;
        const dispatchRows = parsed.lineage.counts.dispatch_rows;
        const namedGaps = (parsed.lineage.gaps ?? []).filter((gap) =>
          String(gap.name).includes("external-reviewer") || String(gap.name).includes("unresolvable")
          || String(gap.name).includes("unbound"));
        assert.ok(
          external > 0 || dispatchRows > 0 || namedGaps.length > 0,
          "must not report quiet false zero when reviewer manifest evidence exists",
        );
        assert.notEqual(external === 0 && dispatchRows === 0 && namedGaps.length === 0, true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("R6: --since-change unions overrides[] continuation sessions into measurement roots", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-overrides-union-"));
      try {
        const changeName = "since-overrides-union";
        const sessionA = "71717171-7171-4171-8171-717171717171";
        const sessionB = "72727272-7272-4272-8272-727272727272";
        const startA = "2026-01-01T00:00:00.000Z";
        const startB = "2026-01-01T03:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionA, [
          userRecord({ id: "u-a", ts: startA, text: "a", cwd: "/repo" }),
          assistantRecord({ id: "a-a", ts: "2026-01-01T00:00:01.000Z", output_tokens: 10 }),
        ]);
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionB, [
          userRecord({ id: "u-b", ts: startB, text: "b", cwd: "/repo" }),
          assistantRecord({ id: "a-b", ts: "2026-01-01T03:00:01.000Z", output_tokens: 20 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionA,
          start_ts: startA,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        appendChangeUsageOverride({
          changeName,
          session_id: sessionB,
          at: startB,
          thresholds: ["output"],
          head_ref_oid: "d".repeat(40),
        });
        recordSessionChangeTransition({ session_id: sessionA, change_name: changeName, at: startA });
        recordSessionChangeTransition({ session_id: sessionB, change_name: changeName, at: startB });
        const output = captureConsoleLog(() => reportCliMain(["--since-change", changeName, "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
        }));
        const parsed = JSON.parse(output);
        const ids = parsed.sessions.map((session) => session.session_id);
        assert.ok(ids.includes(sessionA));
        assert.ok(ids.includes(sessionB), "override-only session B must enter since-change aggregation");
        const b = parsed.sessions.find((session) => session.session_id === sessionB);
        assert.ok(b.status === "ok" || b.status === "unavailable");
        if (b.status === "ok") assert.equal(b.totals.output, 20);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
  it("--since-change --lineage downgrades current-change when a discovered descendant lacks checkpoint attribution", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-lineage-descendant-boundary-"));
      try {
        const changeName = "since-lineage-descendant-boundary";
        const rootId = "52525252-5252-4252-8252-525252525252";
        const childId = "53535353-5353-4353-8353-535353535353";
        const startTs = "2026-01-01T00:00:00.000Z";
        const codexRoot = path.join(tmp, "codex");
        writeCodexFixtureToDisk(codexRoot, rootId, [
          { timestamp: startTs, type: "session_meta", payload: { id: rootId, cwd: process.cwd() } },
          { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ agent_type: "dp-programmer" }) } },
          tokenCountEvent({ ts: "2026-01-01T00:00:02Z", input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, totalTokenUsage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }),
        ]);
        writeCodexFixtureToDisk(codexRoot, childId, [
          { timestamp: "2026-01-01T00:10:00Z", type: "session_meta", payload: { id: childId, cwd: process.cwd(), source: { subagent: { thread_spawn: { parent_thread_id: rootId } } } } },
          tokenCountEvent({ ts: "2026-01-01T00:10:01Z", input_tokens: 7, cached_input_tokens: 0, output_tokens: 3, totalTokenUsage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3 } }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: rootId,
          start_ts: startTs,
          host: "codex",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: rootId, change_name: changeName, at: startTs });

        const output = captureConsoleLog(() => reportCliMain(["--since-change", changeName, "--lineage", "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CODEX_ROOT: codexRoot,
        }));
        const parsed = JSON.parse(output);
        assert.equal(parsed.lineage.counts.descendant_sessions, 1);
        assert.equal(parsed.lineage.claim.scope, "mixed-session");
        assert.ok(!parsed.lineage.claim.claims.includes("current-change"));
        assert.ok(parsed.lineage.gaps.some((gap) => gap.name === "change-attribution-unverified-descendant"));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("Scenario: Unassigned Codex usage cannot support a current-change claim", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-unassigned-codex-usage-"));
      try {
        const changeName = "since-unassigned-codex-usage";
        const sessionId = "64646464-6464-4464-8464-646464646464";
        const startTs = "2026-01-01T00:00:00.000Z";
        const codexRoot = path.join(tmp, "codex");
        const turnUsage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 };
        const outsideUsage = { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 2, total_tokens: 57 };
        const cumulative = { input_tokens: 150, cached_input_tokens: 30, cache_write_input_tokens: 0, output_tokens: 37, reasoning_output_tokens: 7, total_tokens: 187 };
        writeCodexFixtureToDisk(codexRoot, sessionId, [
          sessionMetaRecord({ sessionId, cwd: process.cwd(), ts: startTs }),
          taskStartedEvent({ turnId: "closed-turn", ts: "2026-01-01T00:00:01.000Z" }),
          taskCompleteEvent({ turnId: "closed-turn", ts: "2026-01-01T00:00:02.000Z" }),
          tokenUsageRecordEvent({ ts: "2026-01-01T00:00:03.000Z", threadId: sessionId, responseId: "late-response", turnId: "closed-turn", usage: turnUsage, threadTokenUsage: turnUsage }),
          tokenUsageRecordEvent({ ts: "2026-01-01T00:00:04.000Z", threadId: sessionId, responseId: "outside-response", turnId: null, usage: outsideUsage, threadTokenUsage: cumulative }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: startTs,
          host: "codex",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });

        const output = captureConsoleLog(() => reportCliMain(["--since-change", changeName, "--lineage", "--json"], {
          HOME: tmp,
          DEVPRO_TEST_CODEX_ROOT: codexRoot,
        }));
        const parsed = JSON.parse(output);

        assert.equal(parsed.sessions[0].totals.input, 120, "the bounded session total includes both unique root responses");
        assert.equal(parsed.sessions[0].unassigned_usage.rows.length, 1, "the outside-turn response remains visible in its unassigned bucket");
        assert.equal(parsed.sessions[0].source, "session", "the checkpoint source keeps its existing meaning");
        assert.equal(parsed.sessions[0].usage_source, "token-usage-record");
        assert.equal(parsed.sessions[0].usage_segments.length, 1);
        assert.equal(parsed.sessions[0].usage_reconciliation.status, "reconciled");
        assert.equal(parsed.sessions[0].usage_attribution.status, "unverified");
        assert.equal(parsed.sessions[0].totals.cache_creation, null);
        assert.equal(parsed.totals.cache_creation, null);
        assert.equal(parsed.attribution_verified, false);
        assert.equal(parsed.lineage.claim.scope, "mixed-session");
        assert.ok(!parsed.lineage.claim.claims.includes("current-change"));

        const markdown = captureConsoleLog(() => reportCliMain(["--since-change", changeName], {
          HOME: tmp,
          DEVPRO_TEST_CODEX_ROOT: codexRoot,
        }));
        assert.ok(markdown.includes("attribution_verified=false"));
        assert.ok(markdown.includes("usage_source=token-usage-record"));
        assert.ok(markdown.includes("reconciliation=reconciled"));
        assert.ok(markdown.includes("attribution=unverified"));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("(b) mixed resolvable/unresolvable sessions: coverage partial, unresolvable session_id named, total only counts the resolvable one — and available MUST stay true (明確反例：不得因單一 session 失敗就把整體降為 unavailable)", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-b-"));
      try {
        const changeName = "since-change-b";
        const goodSessionId = "b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b0b0";
        const missingSessionId = "b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, goodSessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 30 }),
        ]);
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: goodSessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        // missingSessionId is registered in the checkpoint but has NO transcript
        // file on disk anywhere — the resolver must fail for it.
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: missingSessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        assert.equal(
          recordSessionChangeTransition({ session_id: goodSessionId, change_name: changeName, at: startTs }).status,
          "written",
        );

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName, "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.available, true, "must NOT collapse to unavailable just because one session_id failed");
        assert.equal(parsed.coverage, "partial");
        assert.equal(parsed.totals.output, 30, "total must only include the resolvable session");
        const missingDetail = parsed.sessions.find((s) => s.session_id === missingSessionId);
        assert.ok(missingDetail, "unresolvable session_id must be named in sessions[], not silently dropped");
        assert.equal(missingDetail.status, "unavailable");
        const goodDetail = parsed.sessions.find((s) => s.session_id === goodSessionId);
        assert.equal(goodDetail.status, "ok");
        assert.equal(goodDetail.totals.output, 30);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("ledger unavailable (never written for this session_id): entry degrades to unavailable/coverage:partial, distinguishable from a resolver failure — 明訂驗收「ledger 讀取回傳 unavailable 時，該筆計入輸出的 unavailable／coverage: partial」", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-ledger-unavailable-"));
      try {
        const changeName = "since-change-ledger-unavailable";
        const sessionId = "c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        // The transcript resolves fine — this is NOT a "session not found"
        // failure. The gap is the global transition ledger itself: no
        // recordSessionChangeTransition call was ever made for this
        // session_id (fail-open write per F-4-3, or a checkpoint predating
        // the ledger), so `_session-transitions.json` does not exist yet.
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 15 }),
        ]);
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: sessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        // Deliberately no recordSessionChangeTransition call.

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName, "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.available, true);
        assert.equal(parsed.coverage, "partial");
        assert.equal(parsed.totals.output, 0, "an unavailable entry must not be counted as 0-usage-but-resolved; total must exclude it entirely");
        assert.equal(parsed.sessions.length, 1);
        assert.equal(parsed.sessions[0].status, "unavailable");
        assert.notEqual(
          parsed.sessions[0].reason,
          "session not found",
          "ledger-unavailable must be a DISTINCT reason from a transcript-resolution failure",
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("(c) missing checkpoint: whole output is unavailable (既有語意不變)", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-c-"));
      try {
        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", "never-checkpointed-change", "--json"], { HOME: tmp });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.available, false);
        assert.equal(parsed.reason, "checkpoint unavailable");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("(d) mixed host sessions[] entries (claude-code + codex) dispatch to their own resolver and sum correctly", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-d-"));
      try {
        const changeName = "since-change-d";
        const claudeSessionId = "d0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0";
        const codexSessionId = "d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        const codexRoot = path.join(tmp, "codex");
        writeClaudeCodeFixtureToDisk(claudeRoot, claudeSessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 11 }),
        ]);
        writeCodexFixtureToDisk(codexRoot, codexSessionId, [
          tokenCountEvent({ ts: startTs, input_tokens: 5, cached_input_tokens: 0, output_tokens: 7 }),
        ]);
        for (const [sessionId, host] of [[claudeSessionId, "claude-code"], [codexSessionId, "codex"]]) {
          assert.equal(
            appendChangeUsageSession({
              changeName,
              session_id: sessionId,
              start_ts: startTs,
              host,
              session_pending_line_count_at_start: 0,
              tasks_line_count_at_start: 0,
            }).status,
            "written",
          );
          assert.equal(
            recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs }).status,
            "written",
          );
        }

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName, "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            DEVPRO_TEST_CODEX_ROOT: codexRoot,
          });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.coverage, "complete");
        assert.equal(parsed.totals.output, 11 + 7, "must sum both hosts' resolved sessions");
        const claudeDetail = parsed.sessions.find((s) => s.session_id === claudeSessionId);
        const codexDetail = parsed.sessions.find((s) => s.session_id === codexSessionId);
        assert.equal(claudeDetail.host, "claude-code");
        assert.equal(claudeDetail.status, "ok");
        assert.equal(codexDetail.host, "codex");
        assert.equal(codexDetail.status, "ok");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("明確反例：一個 host 值不得回退嘗試另一個 host 的 resolver — a claude-code entry whose session_id only exists under the Codex root stays unavailable, never picks up the Codex file's data", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-noresolverfallback-"));
      try {
        const changeName = "since-change-no-fallback";
        const sessionId = "e0e0e0e0-e0e0-e0e0-e0e0-e0e0e0e0e0e0";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude"); // stays empty — no matching file
        const codexRoot = path.join(tmp, "codex");
        writeCodexFixtureToDisk(codexRoot, sessionId, [
          tokenCountEvent({ ts: startTs, input_tokens: 900, cached_input_tokens: 0, output_tokens: 900 }),
        ]);
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: sessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName, "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            DEVPRO_TEST_CODEX_ROOT: codexRoot,
          });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.coverage, "partial");
        assert.equal(parsed.totals.output, 0, "must NOT silently pick up the Codex file's 900-token usage");
        assert.equal(parsed.sessions[0].status, "unavailable");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("明確反例：不得改用「掃描 transcript 目錄比對 mtime 下界」取代精確 session_id 解析 — an unrelated decoy transcript in the same root with a later mtime/ts must not be scanned into the total", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-nomtimescan-"));
      try {
        const changeName = "since-change-no-mtime-scan";
        const sessionId = "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0";
        const decoySessionId = "f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 5 }),
        ]);
        // Decoy: same root, unrelated session_id (not registered in the
        // checkpoint), with a ts far AFTER start_ts and a much larger
        // output_tokens value — an mtime/time-bound scan would wrongly pull
        // this in; exact session_id resolution must not.
        writeClaudeCodeFixtureToDisk(claudeRoot, decoySessionId, [
          userRecord({ id: "u1", ts: "2026-06-01T00:00:00.000Z", text: "decoy", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-06-01T00:00:01.000Z", output_tokens: 99999 }),
        ]);
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: sessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs }).status,
          "written",
        );

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName, "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.coverage, "complete");
        assert.equal(parsed.totals.output, 5, "decoy's 99999 tokens must never leak into the total");
        assert.equal(parsed.sessions.length, 1, "decoy must not appear as a session entry at all");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("F-6-2: session_id transitions from change A to change B — A's output excludes post-transition B usage, B's output excludes pre-transition A usage", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-f62-"));
      try {
        const changeA = "cross-change-a";
        const changeB = "cross-change-b";
        const sessionId = "12121212-1212-1212-1212-121212121212";
        const tA = "2026-01-01T00:00:00.000Z"; // A start_ts / transition-to-A
        const tB = "2026-01-01T02:00:00.000Z"; // transition-to-B
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: "2026-01-01T00:30:00.000Z", text: "A work", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:30:01.000Z", output_tokens: 10 }),
          userRecord({ id: "u2", ts: "2026-01-01T03:00:00.000Z", text: "B work", cwd: "/repo" }),
          assistantRecord({ id: "m2", ts: "2026-01-01T03:00:01.000Z", output_tokens: 20 }),
        ]);
        assert.equal(
          appendChangeUsageSession({
            changeName: changeA,
            session_id: sessionId,
            start_ts: tA,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        assert.equal(
          appendChangeUsageSession({
            changeName: changeB,
            session_id: sessionId,
            start_ts: tB,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeA, at: tA }).status,
          "written",
        );
        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeB, at: tB }).status,
          "written",
        );

        const outputA = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeA, "--json"], { HOME: tmp, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot });
        });
        const parsedA = JSON.parse(outputA);
        assert.equal(parsedA.coverage, "complete");
        assert.equal(parsedA.totals.output, 10, "A must include only its own turn, not B's turn after the transition");

        const outputB = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeB, "--json"], { HOME: tmp, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot });
        });
        const parsedB = JSON.parse(outputB);
        assert.equal(parsedB.coverage, "complete");
        assert.equal(parsedB.totals.output, 20, "B must include only its own turn, not A's turn before the transition");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("F-3f8a05e7: a readable ledger missing A's own record still bounds A at the next transition", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-missing-own-transition-"));
      try {
        const changeA = "missing-own-transition-a";
        const changeB = "missing-own-transition-b";
        const sessionId = "14141414-1414-1414-1414-141414141414";
        const tA = "2026-01-01T00:00:00.000Z";
        const tB = "2026-01-01T02:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: "2026-01-01T00:30:00.000Z", text: "A work", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:30:01.000Z", output_tokens: 10 }),
          userRecord({ id: "u2", ts: "2026-01-01T03:00:00.000Z", text: "B work", cwd: "/repo" }),
          assistantRecord({ id: "m2", ts: "2026-01-01T03:00:01.000Z", output_tokens: 20 }),
        ]);
        assert.equal(
          appendChangeUsageSession({
            changeName: changeA,
            session_id: sessionId,
            start_ts: tA,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        // Simulate the documented fail-open split write: A's per-change
        // checkpoint succeeded, but its transition write did not. The shared
        // ledger remains readable because the later B transition exists.
        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeB, at: tB }).status,
          "written",
        );

        const outputA = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeA, "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          });
        });
        const parsedA = JSON.parse(outputA);
        assert.equal(parsedA.coverage, "complete");
        assert.equal(parsedA.totals.output, 10, "A must exclude usage after the next transition even when its own ledger record is missing");
        assert.equal(parsedA.sessions[0].bounded_by, tB, "the externally visible bound must identify the next transition");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("F-6-2 idempotency (A -> B -> A re-entry): A's aggregate does NOT pick up the second A leg's usage — the straightforward 'next transition record bounds this entry' implementation, not a forced special case", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-reentry-"));
      try {
        const changeA = "reentry-change-a";
        const changeB = "reentry-change-b";
        const sessionId = "13131313-1313-1313-1313-131313131313";
        const tA1 = "2026-01-01T00:00:00.000Z"; // first entry into A
        const tB = "2026-01-01T02:00:00.000Z"; // leaves to B
        const tA2 = "2026-01-01T04:00:00.000Z"; // re-enters A (idempotent: no new sessions[] entry for A)
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: "2026-01-01T00:30:00.000Z", text: "A leg 1", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:30:01.000Z", output_tokens: 10 }),
          userRecord({ id: "u2", ts: "2026-01-01T02:30:00.000Z", text: "B work", cwd: "/repo" }),
          assistantRecord({ id: "m2", ts: "2026-01-01T02:30:01.000Z", output_tokens: 20 }),
          userRecord({ id: "u3", ts: "2026-01-01T04:30:00.000Z", text: "A leg 2", cwd: "/repo" }),
          assistantRecord({ id: "m3", ts: "2026-01-01T04:30:01.000Z", output_tokens: 40 }),
        ]);

        // First entry into A: creates the sessions[] entry.
        assert.equal(
          appendChangeUsageSession({
            changeName: changeA,
            session_id: sessionId,
            start_ts: tA1,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        // Leaves to B.
        assert.equal(
          appendChangeUsageSession({
            changeName: changeB,
            session_id: sessionId,
            start_ts: tB,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        // Re-enters A: appendChangeUsageSession is idempotent per session_id —
        // this must NOT create a second sessions[] entry (task 1's own contract).
        const reentryWrite = appendChangeUsageSession({
          changeName: changeA,
          session_id: sessionId,
          start_ts: tA2,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        assert.equal(reentryWrite.status, "written");

        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeA, at: tA1 }).status,
          "written",
        );
        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeB, at: tB }).status,
          "written",
        );
        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeA, at: tA2 }).status,
          "written",
        );

        const outputA = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeA, "--json"], { HOME: tmp, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot });
        });
        const parsedA = JSON.parse(outputA);
        assert.equal(parsedA.sessions.length, 1, "idempotent write must still leave exactly one sessions[] entry for A");
        assert.equal(parsedA.totals.output, 10, "A's single checkpoint entry (bounded at its own next transition, the move to B) must not include leg 2's usage");
        assert.ok(parsedA.totals.output < 10 + 20 + 40, "must be strictly less than the session's full unfiltered usage");

        const outputB = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeB, "--json"], { HOME: tmp, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot });
        });
        const parsedB = JSON.parse(outputB);
        assert.equal(parsedB.totals.output, 20, "B must include only its own leg, bounded by the re-entry-to-A transition");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("(e) D6 model_time_ms sums TOP-LEVEL turn duration only — a dispatched subagent child's own duration_ms is NOT added on top, since the parent turn's ts-to-ts span already encloses the child's execution window", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-e-"));
      try {
        const changeName = "since-change-e";
        const sessionId = "e0e0e0e0-e0e0-e0e0-e0e0-e0e0e0e0e0e0";
        const startTs = "2026-01-01T01:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        const agentId = "e00e0e0e0e0e0e0e0";
        const projectDir = path.join(claudeRoot, "projects", "proj");
        mkdirSync(projectDir, { recursive: true });
        // Turn 1: BEFORE start_ts — must be excluded from both tokens and
        // model_time_ms entirely (same F-5-1 filter already proven in (a)).
        // Turn 2: AFTER start_ts, dispatches a subagent (toolu_e) mid-turn
        // and resumes with a final message once the child returns — the
        // common real-world shape, since a tool_result does not open a new
        // turn (parseClaudeCodeTurns). Turn 2's own duration_ms therefore
        // spans 02:00:00.000Z -> 02:00:15.000Z (15000ms), which structurally
        // encloses the child's independently-computed 02:00:02 -> 02:00:10
        // window (8000ms).
        const mainRecords = [
          userRecord({ id: "u1", ts: "2026-01-01T00:00:00.000Z", text: "before start_ts", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:05.000Z", output_tokens: 999 }),
          userRecord({ id: "u2", ts: "2026-01-01T02:00:00.000Z", text: "spawn sub after start_ts", cwd: "/repo" }),
          assistantRecord({ id: "m2a", ts: "2026-01-01T02:00:01.000Z", output_tokens: 10, toolUseId: "toolu_e" }),
          assistantRecord({ id: "m2b", ts: "2026-01-01T02:00:15.000Z", output_tokens: 5 }),
        ];
        writeFileSync(
          path.join(projectDir, `${sessionId}.jsonl`),
          mainRecords.map((r) => JSON.stringify(r)).join("\n"),
        );
        const subDir = path.join(projectDir, sessionId, "subagents");
        mkdirSync(subDir, { recursive: true });
        const subRecords = [
          assistantRecord({ id: "s1", ts: "2026-01-01T02:00:02.000Z", output_tokens: 40 }),
          assistantRecord({ id: "s2", ts: "2026-01-01T02:00:10.000Z", output_tokens: 37 }),
        ];
        writeFileSync(
          path.join(subDir, `agent-${agentId}.meta.json`),
          JSON.stringify({ agentType: "general-purpose", description: "sub task", toolUseId: "toolu_e" }),
        );
        writeFileSync(
          path.join(subDir, `agent-${agentId}.jsonl`),
          subRecords.map((r) => JSON.stringify(r)).join("\n"),
        );
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: sessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs }).status,
          "written",
        );

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName, "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.coverage, "complete");
        // Tokens: unaffected by the model_time_ms fix — still summed over
        // flattened rows (parent + child), so the child's 77 output tokens
        // (40 + 37) count alongside turn 2's own 15 (10 + 5). Turn 1's 999
        // (before start_ts) must not appear.
        assert.equal(parsed.totals.output, 92, "tokens must still include the child's own spend via flattened rows");
        // model_time_ms: turn 2's own 15000ms span ONLY. If children were
        // summed on top (the double-count bug), this would be 23000.
        assert.equal(
          parsed.totals.model_time_ms,
          15000,
          "must equal turn 2's own top-level duration only — must NOT add the child's 8000ms on top (double-count)",
        );
        assert.equal(parsed.sessions.length, 1);
        assert.equal(parsed.sessions[0].model_time_ms, 15000);
        assert.equal(parsed.sessions[0].duration_missing_turn_count, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("(f) D6 missing duration_ms on an in-window turn: counts as 0 toward model_time_ms (not skipped), session status stays 'ok' with token totals intact, duration_missing_turn_count names the gap per-session, and overall coverage is NOT flipped by a duration gap alone (coverage only reflects session resolution, per NFR-2 non-conflation)", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-f-"));
      try {
        const changeName = "since-change-f";
        const sessionId = "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        // The assistant record's own ts is null -> computeDurationMs(turn.ts,
        // lastTs) returns null (missing endTs) for this turn. turn.ts itself
        // (the user record's ts) stays a valid string >= start_ts, so the
        // turn is still INCLUDED in filteredTurns — this is "duration
        // unavailable for an in-window turn", not "turn excluded by the
        // start_ts filter" (a different, already-covered case).
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "turn with missing duration", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: null, output_tokens: 42 }),
        ]);
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: sessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );
        assert.equal(
          recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs }).status,
          "written",
        );

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName, "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.available, true);
        assert.equal(parsed.coverage, "complete", "a duration gap must NOT flip overall coverage — the session itself still resolved; duration_missing_turn_count is the named, per-session signal");
        assert.equal(parsed.sessions.length, 1);
        assert.equal(parsed.sessions[0].status, "ok", "a missing duration must NOT evict the session's token totals");
        assert.equal(parsed.sessions[0].totals.output, 42, "token totals must stay intact despite the duration gap");
        assert.equal(parsed.sessions[0].model_time_ms, 0, "missing duration_ms counts as 0, not skipped (D6)");
        assert.equal(parsed.sessions[0].duration_missing_turn_count, 1);
        assert.equal(parsed.totals.model_time_ms, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("--by-class with --since-change: exit code 2 (usage error, same code as --budget-check-without---since-change — NOT 1, which this CLI reserves for budget-exceeded), never a silent exit-0 drop of --by-class", () => {
    // --since-change's rollup aggregates per-session totals from a checkpoint
    // — it has no per-turn data for groupTurnsByClass. Before this fix, this
    // combination fell through the `if (opts.sinceChange)` branch's own
    // return and silently produced a since-change result with no by_class
    // key and no error, indistinguishable from "by-class had nothing to
    // report." That is the same overstated-carrier shape this change exists
    // to close off elsewhere (D13 R7), so the combination must be rejected.
    // Exit code must be 2 (BUDGET_EXIT.UNAVAILABLE), not 1 — this CLI already
    // uses 1 exclusively for budget.exceeded, and a caller that branches on
    // exit code alone (a pre-dispatch budget gate) must not be able to read
    // this usage error as "budget exceeded, block."
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-since-change-byclass-rejected-"));
    try {
      const output = captureConsoleLog(() => {
        const exitCode = reportCliMain(["--since-change", "some-change", "--by-class"], { HOME: tmp });
        assert.equal(exitCode, 2);
      });
      assert.equal(
        output.includes("since-change="),
        false,
        "must reject before touching the checkpoint, not silently roll up without by_class",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// T11 — `--budget-check` (design.md task 5; D10/D11 evaluator wiring +
// F-1-4/F-3-3 meter-reset advisory)
// ===========================================================================

function withCwd(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

/** Isolated git repo for the meter-reset advisory: one commit on `main`
 * (fresh `git init` has no tags/release branches, so resolveAnchor()'s final
 * `main` fallback is what fires — this IS the anchor), optionally followed
 * by a second branch with one commit at a controlled author date (the
 * "branch's first commit since anchor" the advisory compares against). Both
 * dates are caller-controlled via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE for
 * deterministic offset assertions. `branchCommitDate: null` leaves HEAD at
 * the anchor itself (no commits since anchor — the advisory's own
 * `"unavailable"` fixture). */
function initGitRepoWithAnchorAndBranchCommit({ anchorDate, branchCommitDate }) {
  const dir = mkdtempSync(path.join(tmpdir(), "devpro-meter-reset-git-"));
  const git = (args, extraEnv = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...extraEnv } });
  git(["init", "-q"]);
  git(["checkout", "-q", "-b", "main"]);
  git(["config", "user.email", "devpro-test@example.invalid"]);
  git(["config", "user.name", "Devpro Test"]);
  writeFileSync(path.join(dir, "anchor.txt"), "anchor\n");
  git(["add", "anchor.txt"]);
  git(["commit", "-q", "-m", "chore: anchor"], { GIT_AUTHOR_DATE: anchorDate, GIT_COMMITTER_DATE: anchorDate });
  if (branchCommitDate !== null) {
    git(["checkout", "-q", "-b", "chore/meter-reset-fixture"]);
    writeFileSync(path.join(dir, "work.txt"), "work\n");
    git(["add", "work.txt"]);
    git(["commit", "-q", "-m", "chore: first branch commit"], {
      GIT_AUTHOR_DATE: branchCommitDate,
      GIT_COMMITTER_DATE: branchCommitDate,
    });
  }
  return dir;
}

function normalizePathSeparatorsForAssertion(value) {
  return value.replaceAll(String.fromCharCode(92), "/");
}

describe("F-f4a596a7 non-JSON reason masking (report-session-token-usage.mjs L343/L389)", () => {
  it("--host claude-code, non-JSON, missing root: unavailable reason line masks the raw HOME-prefixed root path", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-reason-mask-host-"));
    try {
      // tmp/.claude is deliberately never created — ensureHostRoot's
      // listDir(root) throws, producing reason: `host root not found: ${tmp}/.claude`,
      // the exact shape F-f4a596a7 named. This path has no sanitizeResultItems
      // coverage (that only runs under --json).
      const output = captureConsoleLog(() => {
        reportCliMain(["--host", "claude-code"], { HOME: tmp });
      });
      assert.match(
        normalizePathSeparatorsForAssertion(output),
        /host=claude-code available: false \(reason: host root not found: ~\/\.claude\)/u,
      );
      assert.equal(output.includes(tmp), false, "raw HOME path must not leak into non-JSON stdout");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--since-change, non-JSON: an unresolvable session's reason line masks the raw HOME-prefixed root path", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-reason-mask-since-change-"));
      try {
        const changeName = "since-change-reason-mask";
        const sessionId = "c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0";
        const startTs = "2026-01-01T00:00:00.000Z";
        // Same rationale: tmp/.claude is never created, so this session fails
        // at ensureHostRoot (not at session-not-found), carrying the raw root
        // into rollup.sessions[].reason the way F-f4a596a7 named for L343.
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: sessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName], { HOME: tmp });
        });
        assert.match(
          normalizePathSeparatorsForAssertion(output),
          new RegExp(`session=${sessionId} host=claude-code unavailable \\(reason: host root not found: ~/\\.claude\\)`, "u"),
        );
        assert.equal(output.includes(tmp), false, "raw HOME path must not leak into non-JSON stdout");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

describe("F-84390750 --since-change --json reason masking", () => {
  it("--since-change --json: an unresolvable session's reason field masks the raw HOME-prefixed root path, and the raw HOME string is absent from the entire stdout payload", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-reason-mask-since-change-json-"));
      try {
        const changeName = "since-change-reason-mask-json";
        const sessionId = "d0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0";
        const startTs = "2026-01-01T00:00:00.000Z";
        // Same rationale as the non-JSON sibling test above: tmp/.claude is
        // never created, so this session fails at ensureHostRoot, carrying
        // the raw root into rollup.sessions[].reason. F-84390750: the --json
        // early return (L332-ish) printed `result` unsanitized — it returns
        // before the non-JSON loop's sanitizeHomeAndCwd call ever runs, so
        // that loop's masking gave this branch no coverage at all.
        assert.equal(
          appendChangeUsageSession({
            changeName,
            session_id: sessionId,
            start_ts: startTs,
            host: "claude-code",
            session_pending_line_count_at_start: 0,
            tasks_line_count_at_start: 0,
          }).status,
          "written",
        );

        const output = captureConsoleLog(() => {
          reportCliMain(["--since-change", changeName, "--json"], { HOME: tmp });
        });
        const parsed = JSON.parse(output);
        const session = parsed.sessions.find((s) => s.session_id === sessionId);
        assert.equal(session.status, "unavailable");
        assert.match(
          normalizePathSeparatorsForAssertion(session.reason),
          /^host root not found: ~\/\.claude$/u,
        );
        // Whole-stdout assertion, deliberately not field-scoped: catches any
        // OTHER field in this result shape that might carry the raw HOME
        // path, not only the one field this fixture happens to trigger.
        assert.equal(output.includes(tmp), false, "raw HOME path must not leak anywhere in --json stdout");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

describe("T11 --budget-check", () => {
  it("--budget-check without --since-change: exit code 2 (usage error), never a silent exit-0 no-op", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-no-since-change-"));
    try {
      const output = captureConsoleLog(() => {
        const exitCode = reportCliMain(["--budget-check"], { HOME: tmp });
        assert.equal(exitCode, 2);
      });
      // Nothing budget-shaped on stdout — this is a usage error (stderr), not a
      // checked-but-inconclusive result with a `budget` key a caller could
      // mistake for "checked, nothing exceeded."
      assert.equal(output.includes("budget"), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("unavailable exit code (2): checkpoint never written for this change, distinct from ok/exceeded and does NOT mean exceeded", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-unavailable-"));
      try {
        const exitCode = reportCliMain(
          ["--since-change", "budget-check-never-checkpointed", "--budget-check", "--json"],
          { HOME: tmp },
        );
        assert.equal(exitCode, 2);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("ok exit code (0): checkpoint present, no threshold exceeded", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-ok-"));
      // Non-repo cwd: detectMeterReset's resolveAnchor() call is irrelevant to
      // this test (only exitCode is asserted) and MUST NOT pay this repo's
      // real production-tag-scan cost (~14s observed — topologyLatestTag is
      // O(n^2) in tag count; unrelated to this change, out of scope to fix).
      const cwdDir = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-ok-cwd-"));
      try {
        const changeName = "budget-check-ok";
        const sessionId = "d0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 10 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });
        const exitCode = withCwd(cwdDir, () =>
          reportCliMain(["--since-change", changeName, "--budget-check", "--json"], {
            HOME: tmp,
            DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          }),
        );
        assert.equal(exitCode, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });
  });

  it("exceeded exit code (1): a single session alone clears the threshold (a) output limit", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-exceeded-"));
      const cwdDir = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-exceeded-cwd-"));
      try {
        const changeName = "budget-check-exceeded";
        const sessionId = "e0e0e0e0-e0e0-e0e0-e0e0-e0e0e0e0e0e0";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 900_000 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });
        const output = withCwd(cwdDir, () =>
          captureConsoleLog(() => {
            const exitCode = reportCliMain(["--since-change", changeName, "--budget-check", "--json"], {
              HOME: tmp,
              DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            });
            assert.equal(exitCode, 1);
          }),
        );
        const parsed = JSON.parse(output);
        assert.equal(parsed.budget.exceeded, true);
        assert.ok(parsed.budget.exceeded_thresholds.includes("output"));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });
  });

  // D8 test-lock 1/4 (design.md D8): when a `review_round` override entry's
  // `session_id` is ALREADY present in `sessions[]`, `unionCheckpointMeasurementSessions`
  // MUST produce the identical session list as without that entry at all —
  // proving the union never double-counts or otherwise changes a session
  // that was already going to be measured.
  it("D8 lock 1/4: a review_round entry whose session_id is already in sessions[] changes nothing", () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const baseCheckpoint = {
      sessions: [{ session_id: sessionId, start_ts: "2026-01-01T00:00:00.000Z", host: "claude-code" }],
      overrides: [],
    };
    const withReviewRoundEntry = {
      ...baseCheckpoint,
      overrides: [{
        session_id: sessionId,
        at: "2026-01-01T00:05:00.000Z",
        thresholds: ["review_round"],
        head_ref_oid: "a".repeat(40),
      }],
    };
    assert.deepEqual(
      unionCheckpointMeasurementSessions(withReviewRoundEntry),
      unionCheckpointMeasurementSessions(baseCheckpoint),
      "a review_round override entry for an already-listed session must be a complete no-op on the unioned session list",
    );
  });

  // workflow-cost-controls ADDED "Round Override Consumption Is Recorded For
  // Disclosure" (fix-second-review-loop-friction T6/D8/D9): a `review_round`
  // checkpoint override's `session_id` (session B) is unioned into
  // since-change measurement like any other override session even though
  // `sessions[]` only lists A — the union MAY change raw measured totals,
  // `exceeded_thresholds`, and the raw `budget_state`, but `review_round`
  // MUST NOT enter `deriveEffectiveBudgetState`'s exclusion set (D8: it is
  // never a cost waiver), so re-deriving the effective state against
  // `["review_round"]` MUST equal the raw state byte-for-byte.
  it("Scenario: Unioned review session may change raw measurement but never relaxes effective state", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-review-round-union-"));
      const cwdDir = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-review-round-union-cwd-"));
      try {
        const changeName = "budget-check-review-round-union";
        const sessionA = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
        const sessionB = "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionA, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 10 }),
        ]);
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionB, [
          userRecord({ id: "u2", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m2", ts: "2026-01-01T00:00:01.000Z", output_tokens: 900_000 }),
        ]);
        // A is a normal recorded session; B is present ONLY through a
        // review_round override entry (D6/D7), never appended via
        // appendChangeUsageSession — proving the union, not a duplicate path.
        appendChangeUsageSession({
          changeName,
          session_id: sessionA,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        appendChangeUsageOverride({
          changeName,
          session_id: sessionB,
          at: startTs,
          thresholds: ["review_round"],
          head_ref_oid: "a".repeat(40),
        });
        recordSessionChangeTransition({ session_id: sessionA, change_name: changeName, at: startTs });
        const output = withCwd(cwdDir, () =>
          captureConsoleLog(() => {
            const exitCode = reportCliMain(["--since-change", changeName, "--budget-check", "--json"], {
              HOME: tmp,
              DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            });
            assert.equal(exitCode, 1, "no DEVPRO_COST_BUDGET_OVERRIDE is declared; the exceeded threshold must still block");
          }),
        );
        const parsed = JSON.parse(output);
        assert.equal(parsed.budget.exceeded, true, "session B's unioned usage must be reflected in the raw budget state");
        assert.ok(
          parsed.budget.exceeded_thresholds.includes("output"),
          "session B's 900_000 output tokens (absent from sessions[], present only via the review_round override) must count toward the raw total",
        );
        const effective = deriveEffectiveBudgetState(parsed.budget, ["review_round"]);
        assert.equal(
          effective,
          parsed.budget.budget_state,
          "review_round MUST NOT enter deriveEffectiveBudgetState's exclusion set; the effective state must equal the raw budget_state exactly",
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });
  });

  // D23/D24 (strengthen-subagent-delegation-strategy): the user's exact-set
  // DEVPRO_COST_BUDGET_OVERRIDE is the only way an exceeded --budget-check
  // resumes; raw budget_state stays printed, budget_state_effective excludes
  // the approved thresholds, and a non-effective override keeps exit 1.
  function exceededOverrideFixture(fn) {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-override-"));
      const cwdDir = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-override-cwd-"));
      try {
        const changeName = "budget-check-override";
        const sessionId = "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 900_000 }),
        ]);
        appendChangeUsageSession({ changeName, session_id: sessionId, start_ts: startTs, host: "claude-code", session_pending_line_count_at_start: 0, tasks_line_count_at_start: 0 });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });
        const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
        execFileSync("git", ["init", "-q"], { cwd: cwdDir, env: gitEnv });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: cwdDir, env: gitEnv });
        const run = (envExtra, cwd = cwdDir) => {
          let exitCode = null;
          const output = withCwd(cwd, () => captureConsoleLog(() => {
            exitCode = reportCliMain(["--since-change", changeName, "--budget-check", "--json"], { HOME: tmp, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot, CLAUDE_SESSION_ID: sessionId, ...envExtra });
          }));
          return { exitCode, parsed: JSON.parse(output) };
        };
        fn({ changeName, run, tmp });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });
  }

  it("D24 exact-set DEVPRO_COST_BUDGET_OVERRIDE makes an exceeded check exit 0 with budget_state_effective beside the raw exhausted state", () => {
    exceededOverrideFixture(({ changeName, run }) => {
      const { exitCode, parsed } = run({ DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:output` });
      assert.equal(exitCode, 0);
      assert.equal(parsed.budget.exceeded, true, "raw evaluation is untouched");
      assert.equal(parsed.budget.budget_state, "exhausted", "raw budget_state stays printed");
      assert.equal(parsed.budget_override.effective, true);
      assert.deepEqual(parsed.budget_override.declared_thresholds, ["output"]);
      assert.equal(parsed.budget_state_effective, "below-half", "output excluded; the other two measured values are far below half with complete coverage");
      const again = run({ DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:output` });
      assert.equal(again.exitCode, 0, "repeat with the same session/head stays effective");
    });
  });

  it("D24 non-exact-set, mismatched-change, or absent override keeps exit 1 and never emits budget_state_effective", () => {
    exceededOverrideFixture(({ changeName, run }) => {
      const missing = run({});
      assert.equal(missing.exitCode, 1);
      assert.equal(Object.hasOwn(missing.parsed, "budget_override"), false, "no env → nothing resolved, nothing claimed");
      assert.equal(Object.hasOwn(missing.parsed, "budget_state_effective"), false);
      for (const value of [`${changeName}:cache_read`, `${changeName}:output,cache_read`, `other-change:output`, changeName, `${changeName}:`]) {
        const r = run({ DEVPRO_COST_BUDGET_OVERRIDE: value });
        assert.equal(r.exitCode, 1, value);
        assert.equal(r.parsed.budget_override.effective, false, value);
        assert.equal(Object.hasOwn(r.parsed, "budget_state_effective"), false, value);
      }
    });
  });

  it("D24 override without a resolvable session or a git HEAD is not effective (durable append is the gate)", () => {
    exceededOverrideFixture(({ changeName, run, tmp }) => {
      const noSession = run({ DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:output`, CLAUDE_SESSION_ID: "" });
      assert.equal(noSession.exitCode, 1);
      assert.equal(noSession.parsed.budget_override.effective, false);
      assert.equal(noSession.parsed.budget_override.reason, "session_unresolvable");
      const nonRepo = mkdtempSync(path.join(tmp, "non-repo-"));
      const noHead = run({ DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:output` }, nonRepo);
      assert.equal(noHead.exitCode, 1);
      assert.equal(noHead.parsed.budget_override.reason, "head_ref_oid_unresolvable");
    });
  });

  it("coverage: partial stays visible in --budget-check output when thresholds (a)(b)(c) are not exceeded (F-5-3)", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-partial-"));
      const cwdDir = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-partial-cwd-"));
      try {
        const changeName = "budget-check-partial";
        const goodSessionId = "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0";
        const missingSessionId = "f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, goodSessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 30 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: goodSessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        appendChangeUsageSession({
          changeName,
          session_id: missingSessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: goodSessionId, change_name: changeName, at: startTs });

        const output = withCwd(cwdDir, () =>
          captureConsoleLog(() => {
            reportCliMain(["--since-change", changeName, "--budget-check", "--json"], {
              HOME: tmp,
              DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            });
          }),
        );
        const parsed = JSON.parse(output);
        assert.equal(parsed.coverage, "partial", "coverage marker must remain visible alongside budget output");
        assert.equal(parsed.budget.exceeded, false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });
  });

  // D4 (fix-second-review-loop-friction): the old "threshold (d) wiring:
  // default --pr-number (none) resolves not-applicable; an explicit at-cap PR
  // resolves exceeded" test lived here, proving `round`'s threshold wiring
  // through `--pr-number`. Both halves of its subject are gone: there is no
  // `round` threshold left to resolve, and `--pr-number` now exits 2 before
  // any checkpoint read. Superseded by the two D13 P6 prove-it tests above
  // ("Scenario: --budget-check rejects the retired --pr-number flag" /
  // "Scenario: --budget-check Evaluates Four Named Thresholds"), which pin
  // exactly these two new facts; nothing here would add coverage.

  it("meter-reset advisory: start_ts close to the branch's real first commit is NOT suspected (baseline)", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-meter-reset-ok-"));
      const gitDir = initGitRepoWithAnchorAndBranchCommit({
        anchorDate: "2025-06-01T00:00:00+00:00",
        branchCommitDate: "2025-06-01T01:00:00+00:00",
      });
      try {
        const changeName = "meter-reset-ok";
        const sessionId = "20202020-2020-2020-2020-202020202020";
        const startTs = "2025-06-01T00:30:00.000Z"; // before the first branch commit
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2025-06-01T00:30:01.000Z", output_tokens: 5 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });

        const output = withCwd(gitDir, () =>
          captureConsoleLog(() => {
            reportCliMain(["--since-change", changeName, "--budget-check", "--json"], {
              HOME: tmp,
              DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            });
          }),
        );
        assert.equal(JSON.parse(output).meter_reset_suspected, false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(gitDir, { recursive: true, force: true });
      }
    });
  });

  it("meter-reset advisory: unavailable (not false) when the branch has no commits since anchor yet", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-meter-reset-unavailable-"));
      const gitDir = initGitRepoWithAnchorAndBranchCommit({
        anchorDate: "2025-06-01T00:00:00+00:00",
        branchCommitDate: null,
      });
      try {
        const changeName = "meter-reset-unavailable";
        const sessionId = "30303030-3030-3030-3030-303030303030";
        const startTs = "2025-06-01T00:30:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2025-06-01T00:30:01.000Z", output_tokens: 5 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });

        const output = withCwd(gitDir, () =>
          captureConsoleLog(() => {
            reportCliMain(["--since-change", changeName, "--budget-check", "--json"], {
              HOME: tmp,
              DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            });
          }),
        );
        assert.equal(
          JSON.parse(output).meter_reset_suspected,
          "unavailable",
          "no commits since anchor means genuinely inconclusive, must NOT collapse into false",
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(gitDir, { recursive: true, force: true });
      }
    });
  });

  it("meter-reset advisory: checkpoint deleted then rebuilt triggers meter_reset_suspected (F-3-3 direct regression — the round-2 root_head approach fails this exact scenario)", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-meter-reset-rebuild-"));
      const gitDir = initGitRepoWithAnchorAndBranchCommit({
        anchorDate: "2025-06-01T00:00:00+00:00",
        branchCommitDate: "2025-06-01T01:00:00+00:00",
      });
      try {
        const changeName = "meter-reset-rebuild";
        const originalSessionId = "40404040-4040-4040-4040-404040404040";
        const rebuiltSessionId = "50505050-5050-5050-5050-505050505050";
        const originalStartTs = "2025-06-01T00:30:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, originalSessionId, [
          userRecord({ id: "u1", ts: originalStartTs, text: "hi", cwd: "/repo" }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: originalSessionId,
          start_ts: originalStartTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });

        // Simulate a mid-change checkpoint file loss: delete it entirely,
        // then let it get rebuilt (devpro:change's startup sequence writes an
        // unconditional first entry) with a `start_ts` that reflects "now"
        // — days after the branch's true first commit, not before it.
        const checkpointFile = changeUsageCheckpointPath({ changeName });
        rmSync(checkpointFile, { force: true });
        const rebuiltStartTs = "2025-06-03T12:00:00.000Z"; // ~59.5h after the first branch commit
        writeClaudeCodeFixtureToDisk(claudeRoot, rebuiltSessionId, [
          userRecord({ id: "u1", ts: rebuiltStartTs, text: "hi", cwd: "/repo" }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: rebuiltSessionId,
          start_ts: rebuiltStartTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: rebuiltSessionId, change_name: changeName, at: rebuiltStartTs });

        const output = withCwd(gitDir, () =>
          captureConsoleLog(() => {
            reportCliMain(["--since-change", changeName, "--budget-check", "--json"], {
              HOME: tmp,
              DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            });
          }),
        );
        assert.equal(JSON.parse(output).meter_reset_suspected, true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(gitDir, { recursive: true, force: true });
      }
    });
  });

  it("meter-reset advisory: a checkpoint whose ONLY (never-deleted) entry has a start_ts later than the real first commit also triggers suspected (design.md's second named scenario)", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-meter-reset-late-"));
      const gitDir = initGitRepoWithAnchorAndBranchCommit({
        anchorDate: "2025-06-01T00:00:00+00:00",
        branchCommitDate: "2025-06-01T01:00:00+00:00",
      });
      try {
        const changeName = "meter-reset-late-start-ts";
        const sessionId = "60606060-6060-6060-6060-606060606060";
        const lateStartTs = "2025-06-04T00:00:00.000Z"; // ~71h after the first branch commit
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: lateStartTs, text: "hi", cwd: "/repo" }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: lateStartTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: lateStartTs });

        const output = withCwd(gitDir, () =>
          captureConsoleLog(() => {
            reportCliMain(["--since-change", changeName, "--budget-check", "--json"], {
              HOME: tmp,
              DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            });
          }),
        );
        assert.equal(JSON.parse(output).meter_reset_suspected, true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(gitDir, { recursive: true, force: true });
      }
    });
  });
});

// ===========================================================================
// fix-second-review-loop-friction T1 prove-it (D13 P6; design.md D4;
// output-discipline MODIFIED "Session Token Usage Reporter Flag Semantics"):
// RED against base — `--pr-number` is still silently accepted (parseArgs
// L178-179) and folded straight into `evaluateCostBudget` instead of being
// rejected with exit 2 before any checkpoint read, and `COST_BUDGET_
// THRESHOLDS` still reports a fifth key, `round`, in `--budget-check` output.
// ===========================================================================

function captureConsoleError(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

describe("fix-second-review-loop-friction T1 prove-it (D13 P6)", () => {
  it("Scenario: --budget-check rejects the retired --pr-number flag", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-pr-number-retired-"));
      const cwdDir = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-pr-number-retired-cwd-"));
      try {
        const changeName = "budget-check-pr-number-retired";
        const sessionId = "20202020-2020-2020-2020-202020202020";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 10 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });

        for (const args of [
          ["--since-change", changeName, "--budget-check", "--pr-number", "777", "--json"],
          ["--since-change", changeName, "--budget-check", "--pr-number=777", "--json"],
        ]) {
          let exitCode;
          const stderr = withCwd(cwdDir, () =>
            captureConsoleError(() => {
              exitCode = reportCliMain(args, { HOME: tmp, DEVPRO_TEST_CLAUDE_ROOT: claudeRoot });
            }),
          );
          assert.equal(exitCode, 2, `${args.join(" ")}: base still accepts --pr-number instead of retiring it (exit code)`);
          assert.match(stderr, /round/, `${args.join(" ")}: message must name round as no longer a cost threshold`);
          assert.match(stderr, /DEVPRO_REVIEW_ROUND_OVERRIDE/, `${args.join(" ")}: message must point to the round override`);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });
  });

  it("Scenario: --budget-check Evaluates Four Named Thresholds", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-four-thresholds-"));
      const cwdDir = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-four-thresholds-cwd-"));
      try {
        const changeName = "budget-check-four-thresholds";
        const sessionId = "21212121-2121-2121-2121-212121212121";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 10 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });

        const output = withCwd(cwdDir, () =>
          captureConsoleLog(() => {
            reportCliMain(["--since-change", changeName, "--budget-check", "--json"], {
              HOME: tmp,
              DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
            });
          }),
        );
        const parsed = JSON.parse(output);
        assert.deepEqual(
          Object.keys(parsed.budget.thresholds).sort(),
          ["cache_read", "model_time", "output", "stalled_rounds"],
          "base still reports a fifth threshold key, round",
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });
  });

  // F-slf-r1-04 (review r1): the spec (`output-discipline` spec.md ~:1080)
  // says `--pr-number` is "always rejected with exit 2" — the pre-fix
  // condition gated this on `opts.budgetCheck` also being present, so a
  // caller passing `--since-change`+`--pr-number` WITHOUT `--budget-check`
  // fell through silently instead. Deleting the `opts.budgetCheck &&` removal
  // (i.e. re-adding that gate) makes this test fail.
  it("Scenario: --pr-number is rejected even without --budget-check (F-slf-r1-04)", () => {
    let exitCode;
    const stderr = captureConsoleError(() => {
      exitCode = reportCliMain(["--since-change", "x", "--pr-number", "5"], {});
    });
    assert.equal(exitCode, 2, "--pr-number must exit 2 even when --budget-check is absent");
    assert.match(stderr, /round/, "message must name round as no longer a cost threshold");
    assert.match(stderr, /DEVPRO_REVIEW_ROUND_OVERRIDE/, "message must point to the round override");
  });

  // PR #2875 cross-model review (WARN, carrier_class code): the --help early
  // return ran before the --pr-number retirement check, so `--help
  // --pr-number` exited 0 instead of the required 2. Moving the retirement
  // check back below the help return makes this test fail.
  it("Scenario: --pr-number is rejected even together with --help", () => {
    for (const args of [["--help", "--pr-number", "5"], ["--pr-number=5", "-h"]]) {
      let exitCode;
      const stderr = captureConsoleError(() => {
        captureConsoleLog(() => {
          exitCode = reportCliMain(args, {});
        });
      });
      assert.equal(exitCode, 2, `${args.join(" ")}: --pr-number must exit 2 even when --help is present`);
      assert.match(stderr, /DEVPRO_REVIEW_ROUND_OVERRIDE/, `${args.join(" ")}: message must point to the round override`);
    }
  });

  // F-slf-r1-01 (review r1): the legacy `round`/`review_round` hint
  // (cost-budget-override.mjs's ROUND_EXTENSION_HINT) is surfaced on two
  // output surfaces of this CLI — the JSON `budget_override.hint` field and
  // the text renderer's own `hint:` line (report-session-token-usage.mjs
  // ~:786) — and neither was pinned by a test. Deleting either output
  // (the JSON field's assignment in cost-budget-override.mjs, or the text
  // renderer's `hint:` console.log line) must make this test fail.
  it("Scenario: legacy round override hint surfaces on both --budget-check output surfaces (F-slf-r1-01)", () => {
    withChangeUsageStateDir(() => {
      const tmp = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-round-hint-"));
      const cwdDir = mkdtempSync(path.join(tmpdir(), "devpro-budget-check-round-hint-cwd-"));
      try {
        const changeName = "budget-check-round-hint";
        const sessionId = "30303030-3030-3030-3030-303030303030";
        const startTs = "2026-01-01T00:00:00.000Z";
        const claudeRoot = path.join(tmp, "claude");
        writeClaudeCodeFixtureToDisk(claudeRoot, sessionId, [
          userRecord({ id: "u1", ts: startTs, text: "hi", cwd: "/repo" }),
          assistantRecord({ id: "m1", ts: "2026-01-01T00:00:01.000Z", output_tokens: 900_000 }),
        ]);
        appendChangeUsageSession({
          changeName,
          session_id: sessionId,
          start_ts: startTs,
          host: "claude-code",
          session_pending_line_count_at_start: 0,
          tasks_line_count_at_start: 0,
        });
        recordSessionChangeTransition({ session_id: sessionId, change_name: changeName, at: startTs });
        const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
        execFileSync("git", ["init", "-q"], { cwd: cwdDir, env: gitEnv });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: cwdDir, env: gitEnv });

        const baseEnv = {
          HOME: tmp,
          DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          CLAUDE_SESSION_ID: sessionId,
          DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:round`,
        };

        const jsonOutput = withCwd(cwdDir, () =>
          captureConsoleLog(() => {
            reportCliMain(["--since-change", changeName, "--budget-check", "--json"], baseEnv);
          }),
        );
        const parsed = JSON.parse(jsonOutput);
        assert.equal(parsed.budget_override.effective, false);
        assert.equal(parsed.budget_override.reason, "unknown_threshold_key");
        assert.match(
          parsed.budget_override.hint,
          /DEVPRO_REVIEW_ROUND_OVERRIDE/,
          "the JSON budget_override.hint field must point to the round override",
        );

        const textOutput = withCwd(cwdDir, () =>
          captureConsoleLog(() => {
            reportCliMain(["--since-change", changeName, "--budget-check"], baseEnv);
          }),
        );
        assert.match(
          textOutput,
          /^hint: .*DEVPRO_REVIEW_ROUND_OVERRIDE/m,
          "the text renderer's hint: line must point to the round override",
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });
  });
});

// ===========================================================================
// Review-round findings — F-I1 / F-I2 / F-I3 / F-I4 / F-I6
// ===========================================================================

describe("F-I1 CLI to lint seam: renderMarkdownLedger output feeds hasTokenSpendRecord", () => {
  it("renderMarkdownLedger's real output, pasted into a ## Token 回顧 section, passes hasTokenSpendRecord", () => {
    const result = {
      available: true,
      host: "claude-code",
      session: "abc-123",
      source: "exact",
      cost_usd: 1.5,
      turns: [
        {
          ts: "2026-08-20T10:00:00.000Z",
          actor: "main",
          item: "do thing A",
          duration_ms: 1000,
          tokens: { input: 10, output: 100, cache_read: 50, cache_creation: 5, cache_read_peak: 60 },
          children: [],
        },
      ],
      totals: { input: 10, output: 100, cache_read: 50, cache_creation: 5 },
      gaps: [],
      field_availability: {
        input: "available",
        output: "available",
        cache_creation: "available",
        cost_usd: "available",
        cache_read: "available",
      },
    };
    const md = renderMarkdownLedger(result, {});
    const body = `## Token 回顧\n${md}\n\n## 版本資訊\nRules: v0.0.0 · Tool: test · Model: test\n`;
    const check = hasTokenSpendRecord(body);
    assert.equal(check.valid, true, check.reason);
  });

  it("a result with named gaps still passes, and the gaps: field carries the gap names", () => {
    const result = {
      available: true,
      host: "codex",
      session: "def-456",
      source: "latest-fallback",
      cost_usd: null,
      turns: [
        {
          ts: "2026-08-20T10:00:00.000Z",
          actor: "main",
          item: "",
          duration_ms: null,
          tokens: { input: 5, output: 5, cache_read: 0, cache_creation: null },
          children: [],
        },
      ],
      totals: { input: 5, output: 5, cache_read: 0, cache_creation: null },
      gaps: [{ name: "output-mismatch", ledger_total: 5, host_total: 4, delta: 1 }],
      field_availability: {
        input: "derived",
        output: "available",
        cache_creation: "unverified-on-host",
        cost_usd: "unsupported-by-host",
        cache_read: "available",
      },
    };
    const md = renderMarkdownLedger(result, {});
    assert.match(md, /^- gaps: output-mismatch$/m);
    const body = `## Token 回顧\n${md}\n\n## 版本資訊\n`;
    const check = hasTokenSpendRecord(body);
    assert.equal(check.valid, true, check.reason);
  });
});

describe("F-I2 field_availability.cost_usd is host-aware, not hardcoded", () => {
  it("Claude Code with 0 cost-state records: cost_usd is unverified-on-host, not available", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" }),
      assistantRecord({ id: "m1", ts: "t1", input_tokens: 5 }),
    ];
    const fixture = buildClaudeCodeFixture({ sessionId: "20202020-2020-2020-2020-202020202020", records });
    const result = readClaudeCodeSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.field_availability.cost_usd, "unverified-on-host");
    const md = renderMarkdownLedger(result, {});
    assert.match(md, /^- cost_usd: N\/A: /m);
    assert.doesNotMatch(md, /host 未提供 USD/, "Claude Code DOES support cost_usd; the Codex-specific reason text must not leak here");
  });

  it("Claude Code with a real cost-state record: cost_usd is available", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" }),
      assistantRecord({ id: "m1", ts: "t1", model: "claude-opus-4" }),
      costStateRecord({
        totalCostUSD: 2.5,
        modelUsage: { "claude-opus-4": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      }),
    ];
    const fixture = buildClaudeCodeFixture({ sessionId: "21212121-2121-2121-2121-212121212121", records });
    const result = readClaudeCodeSession({ ...fixture, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.available, true, result.reason);
    assert.equal(result.field_availability.cost_usd, "available");
  });

  it("Codex: cost_usd stays unsupported-by-host, and the markdown reason text names the host", () => {
    const filename = "rollout-2026-01-01T00-00-00-22222222-3333-4444-5555-666666666666.jsonl";
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 10,
        totalTokenUsage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    // readCodexSession() itself does not attach `host` — that is added by the
    // CLI/collectSessionUsage dispatcher wrapper. Mirror that here so
    // renderMarkdownLedger's host-aware branch (F-I2) sees "codex".
    const result = { host: "codex", ...readCodexSession({ ...fixture, sessionId: "22222222-3333-4444-5555-666666666666" }) };
    assert.equal(result.field_availability.cost_usd, "unsupported-by-host");
    const md = renderMarkdownLedger(result, {});
    assert.match(md, /^- cost_usd: N\/A: host 未提供 USD$/m);
  });
});

describe("F-I3 Windows-shaped path separators are handled by sanitizeHomeAndCwd", () => {
  it("a Windows-shaped homeDir prefix is redacted to ~ (backslash separators)", () => {
    const homeDir = "C:\\Users\\alice";
    assert.equal(
      sanitizeItem("C:\\Users\\alice\\secret\\notes.txt", { homeDir }),
      "~\\secret\\notes.txt",
    );
  });

  it("a Windows-shaped homeDir at end-of-string (no trailing separator) still matches", () => {
    const homeDir = "C:\\Users\\alice";
    assert.equal(sanitizeItem("C:\\Users\\alice", { homeDir }), "~");
  });
});

describe("F-I4 Codex reconciliation also names an input-mismatch gap", () => {
  it("input totals that disagree with total_token_usage produce a named gap, not a silent pick", () => {
    const filename = "rollout-2026-01-01T00-00-00-33333333-4444-5555-6666-777777777777.jsonl";
    const records = [
      tokenCountEvent({ ts: "t0", input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 }),
      tokenCountEvent({
        ts: "t1",
        input_tokens: 500,
        cached_input_tokens: 100,
        output_tokens: 50,
        // total_token_usage input/cached disagree with the per-event sum
        // (Σ input=1500 − Σ cached=300 → ledger input 1200) while the host
        // total claims input=1400 − cached=300 → hostInput=1100.
        totalTokenUsage: { input_tokens: 1400, cached_input_tokens: 300, output_tokens: 150 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "33333333-4444-5555-6666-777777777777" });
    const gap = result.gaps.find((g) => g.name === "input-mismatch");
    assert.ok(gap, `expected an input-mismatch gap, got: ${JSON.stringify(result.gaps)}`);
    assert.equal(gap.ledger_total, 1200);
    assert.equal(gap.host_total, 1100);
    assert.equal(gap.delta, 100);
  });

  it("matching input totals do not produce an input-mismatch gap", () => {
    const filename = "rollout-2026-01-01T00-00-00-44444444-5555-6666-7777-888888888888.jsonl";
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 1000,
        cached_input_tokens: 200,
        output_tokens: 100,
        totalTokenUsage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId: "44444444-5555-6666-7777-888888888888" });
    assert.ok(!result.gaps.some((g) => g.name === "input-mismatch"));
  });
});

describe("F-I6 CLI cwdRoots includes the git repo root and worktree roots, not just process.cwd()", () => {
  it("resolveCwdRoots includes process.cwd(), the real repo top-level, and every worktree root", () => {
    const roots = resolveCwdRoots(process.cwd());
    assert.ok(roots.includes(process.cwd()), "process.cwd() itself must still be included");

    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    assert.ok(roots.includes(repoRoot), `expected repo root ${repoRoot} in ${JSON.stringify(roots)}`);

    const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
    const expectedWorktreeRoots = worktreeList
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
    for (const worktreeRoot of expectedWorktreeRoots) {
      assert.ok(roots.includes(worktreeRoot), `expected worktree root ${worktreeRoot} in ${JSON.stringify(roots)}`);
    }
  });
});

describe("F-C4 malformed JSONL lines degrade instead of crashing", () => {
  it("parseJsonl skips unparseable lines and reports malformedCount instead of throwing", () => {
    const content = [
      JSON.stringify({ type: "user", timestamp: "t0" }),
      "{bad json",
      JSON.stringify({ type: "assistant", timestamp: "t1" }),
    ].join("\n");
    const { records, malformedCount } = parseJsonl(content);
    assert.equal(records.length, 2);
    assert.equal(malformedCount, 1);
  });

  it("Claude Code: a malformed trailing line does not crash readClaudeCodeSession; valid lines still produce usable data, and the malformed line is named in gaps", () => {
    const sessionId = "23232323-2323-2323-2323-232323232323";
    const root = "/claude-root";
    const projectDir = "proj";
    const mainPath = `${root}/projects/${projectDir}/${sessionId}.jsonl`;
    const content = [
      JSON.stringify(userRecord({ id: "u1", ts: "t0", text: "hi", cwd: "/repo" })),
      "{this is not valid json, e.g. a half-written trailing line",
      JSON.stringify(assistantRecord({ id: "m1", ts: "t1", output_tokens: 3, input_tokens: 2 })),
    ].join("\n");
    const dirs = {
      [root]: ["projects"],
      [`${root}/projects`]: [projectDir],
      [`${root}/projects/${projectDir}`]: [`${sessionId}.jsonl`],
    };
    const files = { [mainPath]: content };
    const listDir = (p) => fixturePathRequired(dirs, p);
    const readFile = (p) => fixturePathRequired(files, p);

    let threw = false;
    let result;
    try {
      result = readClaudeCodeSession({ root, listDir, readFile, realpath: (p) => p, sessionId, cwdRoots: ["/repo"] });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "a malformed line MUST degrade, not throw");
    assert.equal(result.available, true, result.reason);
    assert.equal(result.turns.length, 1, "the valid lines must still produce a usable turn");
    assert.equal(result.turns[0].tokens.output, 3);
    const gap = result.gaps.find((g) => g.name === "malformed-jsonl-line");
    assert.ok(gap, `expected a malformed-jsonl-line gap, got: ${JSON.stringify(result.gaps)}`);
    assert.equal(gap.count, 1);
  });

  it("Codex: a malformed trailing line does not crash readCodexSession; valid lines still produce usable data, and the malformed line is named in gaps", () => {
    const sessionId = "24242424-2424-2424-2424-242424242424";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const validEvent = tokenCountEvent({
      ts: "t0",
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 10,
      totalTokenUsage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
    });
    const content = [JSON.stringify(validEvent), "not json at all {"].join("\n");
    const fixture = buildCodexFixture({ filenames: { [filename]: [] } });
    const overriddenPath = path.join(fixture.root, "sessions", "2026", "01", "01", filename);
    const readFile = (p) => (p === overriddenPath ? content : fixture.readFile(p));

    let threw = false;
    let result;
    try {
      result = readCodexSession({ ...fixture, readFile, sessionId });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "a malformed line MUST degrade, not throw");
    assert.equal(result.available, true, result.reason);
    assert.equal(result.turns.length, 1, "the valid line must still produce a usable row");
    const gap = result.gaps.find((g) => g.name === "malformed-jsonl-line");
    assert.ok(gap, `expected a malformed-jsonl-line gap, got: ${JSON.stringify(result.gaps)}`);
    assert.equal(gap.count, 1);
  });
});

// ===========================================================================
// F-PR — cross-model / dp-reviewer WARN remediations
// ===========================================================================

describe("F-PR cross-model WARN remediations", () => {
  it("F-PR-CWD: matchesCwdRoots fails closed when realpath throws", () => {
    const throwing = () => {
      throw new Error("ENOENT");
    };
    assert.equal(matchesCwdRoots("/repo/x", ["/repo"], throwing), false);
    assert.equal(matchesCwdRoots("/repo/x", ["/other"], throwing), false);
  });

  it("F-PR-LATEST-MALFORMED: --latest uses last parseable line when trailing line is malformed", () => {
    const newer = "11111111-1111-1111-1111-111111111111";
    const older = "22222222-2222-2222-2222-222222222222";
    const newerContent = [
      JSON.stringify(sessionMetaRecord({ sessionId: newer, cwd: "/repo", ts: "t0" })),
      JSON.stringify(tokenCountEvent({ ts: "t9", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 })),
      "{half-written trailing line",
    ].join("\n");
    const olderContent = [
      JSON.stringify(sessionMetaRecord({ sessionId: older, cwd: "/repo", ts: "t0" })),
      JSON.stringify(tokenCountEvent({ ts: "t5", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 })),
    ].join("\n");
    const root = "/codex-root";
    const datePath = "2026/01/01";
    const newerFile = `rollout-2026-01-01T00-00-00-${newer}.jsonl`;
    const olderFile = `rollout-2026-01-01T00-00-00-${older}.jsonl`;
    const dirs = {
      [root]: ["sessions"],
      [`${root}/sessions`]: ["2026"],
      [`${root}/sessions/2026`]: ["01"],
      [`${root}/sessions/2026/01`]: ["01"],
      [`${root}/sessions/${datePath}`]: [newerFile, olderFile],
    };
    const files = {
      [`${root}/sessions/${datePath}/${newerFile}`]: newerContent,
      [`${root}/sessions/${datePath}/${olderFile}`]: olderContent,
    };
    const listDir = (p) => fixturePathRequired(dirs, p);
    const readFile = (p) => fixturePathRequired(files, p);
    const result = readCodexSession({ root, listDir, readFile, realpath: (p) => p, latest: true, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    assert.equal(result.session, newer);
  });

  it("F-PR-CODEX-NO-TOTAL: cache_read is unverified-on-host when total_token_usage is absent", () => {
    const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      { type: "event_msg", timestamp: "t1", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, total_tokens: 13 } } } },
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId });
    assert.equal(result.field_availability.cache_read, "unverified-on-host");
    assert.ok(result.gaps.some((g) => g.name === "no-total-token-usage"));
  });

  it("F-PR-CODEX-RESET-RECON: mid-rollout total_token_usage reset names gaps; render uses host totals", () => {
    const sessionId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const filename = `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`;
    const records = [
      sessionMetaRecord({ sessionId, cwd: "/repo", ts: "t0" }),
      tokenCountEvent({
        ts: "t1",
        input_tokens: 1000,
        cached_input_tokens: 200,
        output_tokens: 100,
        totalTokenUsage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 },
      }),
      tokenCountEvent({
        ts: "t2",
        input_tokens: 50,
        cached_input_tokens: 10,
        output_tokens: 5,
        totalTokenUsage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 },
      }),
    ];
    const fixture = buildCodexFixture({ filenames: { [filename]: records } });
    const result = readCodexSession({ ...fixture, sessionId });
    assert.ok(result.gaps.some((g) => g.name === "codex-usage-mixed-unresolved"));
    assert.equal(result.usage_source, "mixed-unresolved");
    assert.equal(result.usage_segments.length, 2);
    assert.equal(result.totals.input, 40, "a reset uses only the latest epoch subtotal");
    assert.equal(result.totals.output, 5);
    assert.equal(result.totals.cache_read, 10);
    const md = renderMarkdownLedger({ host: "codex", ...result }, {});
    assert.match(md, /usage_reconciliation: unverified/);
    assert.match(md, /cache_read 10/);
    assert.match(md, /output 5/);
  });

  it("F-PR-SUBAGENT: subagent read failures are named in gaps", () => {
    const sessionId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const root = "/claude-root";
    const projectDir = "proj";
    const mainPath = `${root}/projects/${projectDir}/${sessionId}.jsonl`;
    const records = [
      userRecord({ id: "u1", ts: "t0", cwd: "/repo", text: "hi" }),
      assistantRecord({ id: "m1", ts: "t1", output_tokens: 1, input_tokens: 1, toolUseId: "toolu_sub" }),
    ];
    const subDir = `${root}/projects/${projectDir}/${sessionId}/subagents`;
    const dirs = {
      [root]: ["projects"],
      [`${root}/projects`]: [projectDir],
      [`${root}/projects/${projectDir}`]: [`${sessionId}.jsonl`],
      [subDir]: ["broken-agent"],
    };
    const files = {
      [mainPath]: records.map((r) => JSON.stringify(r)).join("\n"),
      [`${subDir}/broken-agent/meta.json`]: "{not json",
    };
    const listDir = (p) => fixturePathRequired(dirs, p);
    const readFile = (p) => fixturePathRequired(files, p);
    const result = readClaudeCodeSession({ root, listDir, readFile, realpath: (p) => p, sessionId, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    const gap = result.gaps.find((g) => g.name === "subagent-read-failed");
    assert.ok(gap);
    assert.equal(gap.count, 1);
  });

  it("F-PR-SUBAGENT: parsed subagent missing toolUseId is named in gaps", () => {
    const sessionId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const fixture = buildClaudeCodeFixture({
      sessionId,
      records: [userRecord({ id: "u1", ts: "t0", cwd: "/repo", text: "hi" })],
      subagents: [{
        id: "no-tool-id",
        meta: { agentType: "subagent", description: "orphan" },
        records: [assistantRecord({ id: "sa1", ts: "t1", output_tokens: 1, input_tokens: 1 })],
      }],
    });
    const result = readClaudeCodeSession({ ...fixture, sessionId, cwdRoots: ["/repo"] });
    assert.equal(result.available, true);
    const gap = result.gaps.find((g) => g.name === "subagent-missing-tool-use-id");
    assert.ok(gap);
    assert.equal(gap.count, 1);
  });
});

// ===========================================================================
// Misc shared-helper smoke checks
// ===========================================================================

describe("shared helpers", () => {
  it("resolveCodexSessionId rejects malformed env values", () => {
    assert.equal(resolveCodexSessionId({ CODEX_SESSION_ID: "not-a-uuid" }), null);
    assert.equal(
      resolveCodexSessionId({ CODEX_SESSION_ID: "17171717-1717-1717-1717-171717171717" }),
      "17171717-1717-1717-1717-171717171717",
    );
  });

  it("parseCodexTokenCountEvents ignores non-token_count records", () => {
    const { rows } = parseCodexTokenCountEvents([{ type: "other" }]);
    assert.deepEqual(rows, []);
  });

  it("F-C1b: parseCodexTokenCountEvents reads the real event_msg/payload envelope and skips info:null events", () => {
    const records = [
      { type: "session_meta", timestamp: "t-1", payload: { id: "x", cwd: "/repo" } },
      // Real Codex rollout files legitimately contain a token_count event
      // whose info is null (observed on the first event of a session) — this
      // MUST be skipped, not normalized into a phantom zero-token row.
      { type: "event_msg", timestamp: "t0", payload: { type: "token_count", info: null } },
      tokenCountEvent({ ts: "t1", input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }),
    ];
    const { rows, totalUsage } = parseCodexTokenCountEvents(records);
    assert.equal(rows.length, 1, "the info:null event must not produce a row");
    assert.equal(rows[0].ts, "t1");
    assert.equal(totalUsage, null, "no total_token_usage was ever supplied in this fixture");
  });

  it("F-C1b: parseCodexTokenCountEvents takes total_token_usage from the last event that HAS info, even if a later info:null event exists", () => {
    const records = [
      tokenCountEvent({
        ts: "t0",
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 10,
        totalTokenUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
      }),
      // A trailing info:null event (e.g. a rate-limit-only tick) must not
      // shadow the last REAL total_token_usage.
      { type: "event_msg", timestamp: "t1", payload: { type: "token_count", info: null } },
    ];
    const { totalUsage } = parseCodexTokenCountEvents(records);
    assert.deepEqual(totalUsage, { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 });
  });
});

// ===========================================================================
// T10 (strengthen-subagent-delegation-strategy): subagent transcript
// delegation evidence — meta agentType/spawnDepth, dispatch turn count,
// prompt digest (never the prompt text), start/end timestamps.
// ===========================================================================

describe("T10 subagent delegation evidence", () => {
  it("parseSubagentTranscript exposes agent_type/spawn_depth/dispatch_turns/prompt_sha256/start_ts/end_ts", () => {
    const meta = { toolUseId: "toolu_9", agentType: "dp-architect", description: "verify", spawnDepth: 1 };
    const prompt = "mode: update\n\nbounded verification";
    const records = [
      { type: "user", timestamp: "2026-09-03T01:00:00.000Z", message: { role: "user", content: prompt } },
      assistantRecord({ id: "s1", ts: "2026-09-03T01:00:05.000Z", stop_reason: "end_turn", output_tokens: 3 }),
      { type: "user", timestamp: "2026-09-03T01:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] } },
      { type: "user", timestamp: "2026-09-03T01:02:00.000Z", message: { role: "user", content: "follow-up via SendMessage" } },
      assistantRecord({ id: "s2", ts: "2026-09-03T01:02:30.000Z", stop_reason: "end_turn", output_tokens: 4 }),
    ];
    const subagent = parseSubagentTranscript(meta, records);
    assert.equal(subagent.agent_type, "dp-architect");
    assert.equal(subagent.spawn_depth, 1);
    assert.equal(subagent.dispatch_turns, 2, "tool_result-only user records are not dispatch turns");
    assert.equal(subagent.prompt_sha256, createHash("sha256").update(prompt).digest("hex"));
    assert.equal(subagent.start_ts, "2026-09-03T01:00:05.000Z");
    assert.equal(subagent.end_ts, "2026-09-03T01:02:30.000Z");
    assert.equal(JSON.stringify(subagent).includes("bounded verification"), false, "prompt text is never carried");
  });

  it("parseSubagentTranscript leaves evidence null when meta lacks it (no coercion to 0 or fresh)", () => {
    const subagent = parseSubagentTranscript({ toolUseId: "toolu_0" }, [assistantRecord({ id: "s1", ts: "t1", stop_reason: "end_turn" })]);
    assert.equal(subagent.agent_type, null);
    assert.equal(subagent.spawn_depth, null);
    assert.equal(subagent.prompt_sha256, null);
    assert.equal(subagent.dispatch_turns, 0);
    assert.equal(subagent.context_mode, null);
  });
});

describe("T10 per-block assistant records keep every tool_use id for subagent attachment", () => {
  it("two records with the same message id (apiBlockIndex split) both contribute tool_use ids", () => {
    const records = [
      userRecord({ id: "u1", ts: "t0", text: "spawn two" }),
      { ...assistantRecord({ id: "m1", ts: "t1", stop_reason: null, output_tokens: 7, toolUseId: "toolu_first" }), apiBlockIndex: 0 },
      { ...assistantRecord({ id: "m1", ts: "t1", stop_reason: "tool_use", output_tokens: 7, toolUseId: "toolu_second" }), apiBlockIndex: 1 },
    ];
    const turns = parseClaudeCodeTurns(records);
    assert.equal(turns.length, 1);
    assert.deepEqual([...turns[0].toolUseIds].sort(), ["toolu_first", "toolu_second"]);
    assert.equal(turns[0].tokens.output, 7, "collapsed usage is not double counted");
  });
});

describe("T29 Codex continuation through the lineage CLI (fixture codex-continuation-followup-task.json)", () => {
  const fixture = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "session-usage-lineage", "codex-continuation-followup-task.json"), "utf8"));
  const rootId = "61616161-6161-4161-8161-616161616161";
  const childId = "62626262-6262-4262-8262-626262626262";
  const substitute = (record) => JSON.parse(JSON.stringify(record).replaceAll("<parent-id>", rootId).replaceAll("<child-id>", childId).replaceAll("<cwd>", process.cwd().replaceAll("\\", "\\\\")));
  const stamp = (records, base) => records.map((record, index) => ({ timestamp: new Date(Date.parse(base) + index * 1000).toISOString(), ...substitute(record) }));
  const usage = (ts) => tokenCountEvent({ ts, input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, totalTokenUsage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });

  function runLineage(codexRoot, tmp) {
    let exitCode;
    const output = captureConsoleLog(() => {
      exitCode = reportCliMain(["--host", "codex", "--session", rootId, "--lineage", "--json"], { HOME: tmp, DEVPRO_TEST_CODEX_ROOT: codexRoot });
    });
    assert.equal(exitCode, 0);
    return JSON.parse(output);
  }

  it("derives policy_mode fresh, continuation_turns 1 and child_round_trips 2 from the parent/child rollout pair", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-codex-continuation-"));
    try {
      const codexRoot = path.join(tmp, "codex");
      const parent = stamp(fixture.parent_rollout, "2026-01-01T00:00:00Z");
      parent.splice(parent.length - 1, 0, usage("2026-01-01T00:00:20Z"));
      writeCodexFixtureToDisk(codexRoot, rootId, parent);
      const child = stamp(fixture.child_rollout, "2026-01-01T00:00:30Z");
      child.splice(child.length - 1, 0, usage("2026-01-01T00:00:50Z"));
      writeCodexFixtureToDisk(codexRoot, childId, child);
      const parsed = runLineage(codexRoot, tmp);
      assert.equal(parsed.lineage.counts.descendant_sessions, 1);
      const row = parsed.lineage.delegation.per_contributor.find((item) => item.identity === `codex:${childId}`);
      assert.ok(row, "child contributor row present");
      assert.equal(row.policy_mode, "fresh");
      assert.equal(row.continuation_turns, 1);
      assert.equal(row.spawn_depth, 1);
      assert.equal(row.agent_type, "dp-probe-preload");
      assert.equal(row.lane, "work");
      assert.equal(row.responsibility_id, "unknown", "opaque Codex message carries no admission digest");
      assert.equal(parsed.lineage.delegation.child_round_trips, 2);
      assert.equal(parsed.lineage.delegation.policy_mode_counts.fresh, 1);
      assert.equal(parsed.lineage.delegation.policy_mode_counts.continue, 1);
      assert.equal(parsed.lineage.delegation.gaps.some((gap) => gap.name === "codex-continuation-unverified" || gap.name === "codex-context-mode-unknown" || gap.name === "policy-mode-unknown"), false);
      const serialized = JSON.stringify(parsed);
      assert.ok(!serialized.includes("spawn_carrier"));
      assert.ok(!serialized.includes("opaque-fernet"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("names codex-continuation-unverified when the child rollout has no task_started boundaries, and codex-context-mode-unknown when the spawn arguments carry no mode", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpro-codex-continuation-gap-"));
    try {
      const codexRoot = path.join(tmp, "codex");
      const parent = stamp(fixture.parent_rollout, "2026-01-01T00:00:00Z").map((record) => {
        if (record.payload?.type === "function_call" && record.payload.name === "spawn_agent") {
          return { ...record, payload: { ...record.payload, arguments: JSON.stringify({ agent_type: "dp-probe-preload", message: "<opaque>", task_name: "t27_codex_preload_and_continuation_probe" }) } };
        }
        return record;
      });
      parent.splice(parent.length - 1, 0, usage("2026-01-01T00:00:20Z"));
      writeCodexFixtureToDisk(codexRoot, rootId, parent);
      const childMeta = stamp(fixture.child_rollout, "2026-01-01T00:00:30Z")[0];
      writeCodexFixtureToDisk(codexRoot, childId, [childMeta, usage("2026-01-01T00:00:50Z")]);
      const parsed = runLineage(codexRoot, tmp);
      const row = parsed.lineage.delegation.per_contributor.find((item) => item.identity === `codex:${childId}`);
      assert.ok(row);
      assert.equal(row.continuation_turns, null);
      assert.equal(row.policy_mode, "unknown");
      assert.equal(row.spawn_depth, 1);
      assert.equal(parsed.lineage.delegation.child_round_trips, "unknown");
      const names = parsed.lineage.delegation.gaps.filter((gap) => gap.identity === `codex:${childId}`).map((gap) => gap.name);
      assert.deepEqual(names, ["codex-continuation-unverified", "codex-context-mode-unknown", "policy-mode-unknown"]);
      assert.equal(parsed.lineage.gaps.some((gap) => gap.name === "codex-continuation-unverified"), false, "continuation gaps do not degrade spawn observability");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
