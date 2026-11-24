/**
 * session-token-usage.mjs
 *
 * Per-session token usage reader for Claude Code and Codex CLI. Reads each
 * host's own transcript/rollout format and reports REAL host-reported token
 * spend as a per-work-unit ledger, replacing byte/3.5 estimates.
 *
 * ANCHOR DATE: 截至 2026-08-28，Claude Code / Codex CLI 0.149.1 觀察到的格式
 * （2026-08-28 修訂：對照本機真實 `~/.codex/sessions/**` 與
 * `~/.claude/projects/**` 資料，修正 T5 設計文字誤記的 Codex rollout 事件外層
 * 包裝——見下方 "Codex event envelope" 說明——以及 Claude Code `message.content`
 * 的真實型別）。
 * L1 (design.md Context): neither host's transcript format is a public
 * contract. Every reader here accepts injected `root`/`readFile`/`listDir`/
 * `realpath` so it never touches the real filesystem in tests, and every
 * degradation path returns `{ available: false, reason }` rather than
 * throwing, so format drift is visible instead of a silent crash.
 *
 * Codex rollout directory layout (real, NOT flat): `<CODEX_HOME>/sessions/
 * <YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl` — three levels of
 * date subdirectories, not a flat `sessions/*.jsonl`.
 *
 * Codex event envelope (real, differs from the original T5 design text):
 * every line's `type` is one of `session_meta` / `turn_context` /
 * `response_item` / `event_msg`. `session_meta`'s session id and cwd live at
 * `record.payload.id` / `record.payload.cwd` (NOT `record.session_id` /
 * `record.cwd`). Token usage events are `record.type === "event_msg"` with
 * `record.payload.type === "token_count"` and the actual counters at
 * `record.payload.info` (NOT `record.info`); `record.payload.info`
 * MAY be `null` (skipped, never normalized to a zero-token row). Turn
 * boundaries come from `event_msg` `task_started` / `task_complete` /
 * `turn_aborted` (the last two carry `duration_ms`). User prompts and
 * `spawn_agent` `agent_type` (including `dp-*`) are extracted from
 * `response_item` and appended to `項目` as `[spawn: ...]` metadata; caller
 * rollout token rows keep `誰: main` because spawn does not prove child
 * attribution. Claude Code
 * `message.content` for a genuine typed user prompt is a plain STRING, not an
 * array — arrays only occur for `tool_result` / mixed `tool_result`+`text`
 * content.
 *
 * Vendor-leak boundary (design.md "Vendor-leak 邊界"): the host-internal
 * field names used in this file (`totalCostUSD`, `modelUsage`, `token_count`,
 * `cached_input_tokens`, transcript directory layout) MAY live here and in
 * `platform-adapters/*-capabilities.md`, but MUST NOT appear in
 * `session-recap.md` or any other shared rule leaf.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { classifySessionUsageGap } from "./session-usage-gap-classification.mjs";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** UUID-shape whitelist for `--session` / `CODEX_SESSION_ID`. Fail-closed gate: a value
 * that does not match MUST NOT reach any glob/path assembly (D10). */
export function isValidSessionIdShape(value) {
  return typeof value === "string" && UUID_SHAPE.test(value);
}

/**
 * Bounded opaque-id whitelist for provider-neutral host sessions
 * (`DEVPRO_HOST_SESSION_ID`, any runtime). Identity-recording paths may accept
 * this shape; transcript **path assembly** MUST keep using the UUID whitelist
 * above and MUST NOT consume neutrally-shaped ids.
 */
const NEUTRAL_SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export function isValidNeutralSessionIdShape(value) {
  return typeof value === "string" && NEUTRAL_SESSION_ID_SHAPE.test(value);
}

// 551 MB 的 Claude 對話紀錄會讓 readFileSync 丟 ERR_STRING_TOO_LONG（Node 字串上限），
// 呼叫端（second-review renderer 的成本 advisory、post-PR hook）因此整個中止。
// 超過上限就當作拿不到用量，回傳具名原因，讓上層降級成 unavailable 而不是失敗。
export const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

function defaultReadFile(absPath) {
  return readFileSync(absPath, "utf8");
}

function defaultFileSize(absPath) {
  return statSync(absPath).size;
}

function readTranscript(file, { readFile, fileSize, preloadedContent }) {
  if (preloadedContent !== undefined && preloadedContent !== null) return { content: preloadedContent };
  // 取不到大小（測試替身、權限）就照舊交給 readFile 決定；只有量到超過上限才提前降級。
  let size;
  try {
    size = fileSize(file);
  } catch {
    size = undefined;
  }
  if (size !== undefined && size > MAX_TRANSCRIPT_BYTES) return { error: "transcript too large" };
  try {
    return { content: readFile(file) };
  } catch (error) {
    if (error?.code === "ERR_STRING_TOO_LONG") return { error: "transcript too large" };
    return { error: `transcript unreadable (${error?.code || "error"})` };
  }
}

function defaultListDir(absPath) {
  return readdirSync(absPath);
}

function defaultRealpath(absPath) {
  return realpathSync(absPath);
}

/** Host root existence probe shared by both readers (T1 skeleton contract). */
export function ensureHostRoot({ root, listDir = defaultListDir }) {
  if (!root) return { available: false, reason: "no root configured" };
  try {
    listDir(root);
    return { available: true };
  } catch {
    return { available: false, reason: `host root not found: ${root}` };
  }
}

function splitPathSegments(value) {
  return String(value ?? "").split(/[\\/]+/u).filter(Boolean);
}

function isPrefixSegments(prefix, full) {
  if (prefix.length > full.length) return false;
  return prefix.every((segment, index) => segment === full[index]);
}

function safeRealpath(value, realpath) {
  try {
    return (realpath ?? defaultRealpath)(value);
  } catch {
    // F-PR-CWD: fail closed — if realpath fails, cwd containment MUST NOT
    // fall back to unnormalized segment comparison (path aliases / traversal).
    return null;
  }
}

/**
 * cwd containment via realpath'd, segment-wise prefix comparison (NOT string
 * prefix — `/repo-foo` must not match root `/repo`; `/repo/.worktree/x` must).
 */
export function matchesCwdRoots(cwd, cwdRoots, realpath = defaultRealpath) {
  if (!cwd || !Array.isArray(cwdRoots) || cwdRoots.length === 0) return false;
  const resolvedCwd = safeRealpath(cwd, realpath);
  if (resolvedCwd === null) return false;
  const cwdSegments = splitPathSegments(resolvedCwd);
  return cwdRoots.some((root) => {
    const resolvedRoot = safeRealpath(root, realpath);
    if (resolvedRoot === null) return false;
    const rootSegments = splitPathSegments(resolvedRoot);
    return isPrefixSegments(rootSegments, cwdSegments);
  });
}

/**
 * F-C1c: scan at most `maxLines` non-empty lines from the START of `content`
 * without allocating a full lines array — real Codex rollout files observed
 * on this machine reach 1.4GB, and `--latest` discovery previously read AND
 * fully `parseJsonl`'d (or retained whole) every candidate file just to peek
 * at one field, which exhausted the heap once F-C1's directory-walk fix
 * started actually finding real files and F-I6 widened `cwdRoots` to every
 * worktree of this repo. Returns the first truthy `predicate(record)` result,
 * or `null` if none of the first `maxLines` parseable lines match.
 */
function scanLeadingRecords(content, maxLines, predicate) {
  const text = String(content ?? "");
  let start = 0;
  let scanned = 0;
  while (start <= text.length && scanned < maxLines) {
    const nl = text.indexOf("\n", start);
    const rawEnd = nl === -1 ? text.length : nl;
    const rawLine = text.slice(start, rawEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length > 0) {
      scanned += 1;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        record = null;
      }
      if (record) {
        const result = predicate(record);
        if (result) return result;
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return null;
}

/** F-C1c: last non-empty line of `content`, found by scanning backward from
 * the end without splitting the whole file into a lines array (same
 * large-file memory concern as `scanLeadingRecords`). */
function lastNonEmptyLine(content) {
  const text = String(content ?? "");
  let end = text.length;
  while (end > 0) {
    if (text[end - 1] === "\n" || text[end - 1] === "\r") {
      end -= 1;
      continue;
    }
    const nl = text.lastIndexOf("\n", end - 1);
    const start = nl + 1;
    const line = text.slice(start, end);
    if (line.trim().length > 0) return line;
    end = start;
  }
  return "";
}

/** F-PR-LATEST-MALFORMED: last *parseable* JSONL line — a malformed trailing
 * line (live transcript still being written) must not zero out lastTs and
 * let --latest pick an older session. */
function lastParseableJsonLine(content) {
  const text = String(content ?? "");
  let end = text.length;
  while (end > 0) {
    if (text[end - 1] === "\n" || text[end - 1] === "\r") {
      end -= 1;
      continue;
    }
    const nl = text.lastIndexOf("\n", end - 1);
    const start = nl + 1;
    const rawLine = text.slice(start, end);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length > 0) {
      try {
        return JSON.parse(line);
      } catch {
        // keep scanning backward past malformed tail lines
      }
    }
    end = start;
  }
  return null;
}

/**
 * F-C4: a malformed trailing line (e.g. a half-written line at the end of a
 * live transcript still being appended to) MUST degrade, not crash the whole
 * CLI — the header docblock's fail-closed contract applies per-line, not just
 * per-file. Unparseable lines are skipped and counted in `malformedCount` so
 * callers can surface a named `gaps` entry instead of silently dropping them.
 */
export function parseJsonl(content) {
  const lines = String(content ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  const records = [];
  let malformedCount = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      malformedCount += 1;
    }
  }
  return { records, malformedCount };
}

const CODEX_RETAINED_RECORD_TYPES = new Set(["session_meta", "event_msg"]);

/**
 * F-C1c: parse a Codex rollout JSONL file without retaining turn_context/
 * response_item payloads. Real rollout files reach 1.4GB+; fully retaining
 * every parsed line in a generic records[] array inflated a 218MB winner to
 * ~4GB peak heap once F-C1's directory-walk fix started actually finding real
 * files. Streams line-by-line (no full-file .split()) and only keeps record
 * types consumed downstream (session_meta / event_msg).
 */
export function parseCodexJsonl(content) {
  const records = [];
  let malformedCount = 0;
  const text = String(content ?? "");
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const rawEnd = nl === -1 ? text.length : nl;
    const rawLine = text.slice(start, rawEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length > 0) {
      try {
        const record = JSON.parse(line);
        if (record && CODEX_RETAINED_RECORD_TYPES.has(record.type)) {
          records.push(record);
        }
      } catch {
        malformedCount += 1;
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return { records, malformedCount };
}

// ---------------------------------------------------------------------------
// sanitizeItem (T1 / D7)
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Sentinel pair standing in for the literal `<`/`>` of the "<enc-cwd>" placeholder
// while sanitizeHomeAndCwd's output still has to pass through truncation, `&`
// normalization, and character-reference encoding (steps 2-4). Those later steps
// would otherwise escape our OWN placeholder's `<`/`>` into `&lt;`/`>`. Restored
// to literal `<`/`>` as sanitizeItem's very last step. Private-use codepoints:
// never produced by any rule in encodeActiveCharacters, so they pass through
// steps 2-4 completely untouched.
const ENC_CWD_OPEN = "\uE000";
const ENC_CWD_CLOSE = "\uE001";

/** Step 1: home-dir prefix -> "~/"; url-encoded (dash-joined) cwd -> "<enc-cwd>/<last>". */
export function sanitizeHomeAndCwd(text, homeDir) {
  if (!homeDir) return text;
  let result = text;
  const escapedHome = escapeRegExp(homeDir);
  // F-I3: the lookahead MUST recognize BOTH `/` and `\` as path separators —
  // a hardcoded `/`-only class is a no-op on Windows-shaped paths
  // (`C:\Users\alice\...`), silently leaking the account name in full.
  result = result.replace(new RegExp(`${escapedHome}${String.raw`(?=[\\/\s]|$)`}`, "gu"), "~");

  // Same fix for the url-encoded (dash-joined) cwd form: Windows-shaped
  // homeDir uses `\` as its separator, not `/`.
  const encodedHome = homeDir.replaceAll(/[\\/]/gu, "-");
  const escapedEncodedHome = escapeRegExp(encodedHome);
  const placeholder = `${ENC_CWD_OPEN}enc-cwd${ENC_CWD_CLOSE}`;
  result = result.replace(
    new RegExp(`${escapedEncodedHome}[A-Za-z0-9._-]*`, "gu"),
    (match) => {
      const segments = match.split("-").filter(Boolean);
      const last = segments.at(-1);
      return last ? `${placeholder}/${last}` : placeholder;
    },
  );
  return result;
}

/** Step 2: truncate at `itemWidth` RAW characters (pre-escape), append "…". */
function truncateRaw(text, width) {
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  return `${chars.slice(0, width).join("")}…`;
}

const CONTROL_OR_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u202A-\u202E\u2066-\u2069]/u;

function isWordChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/u.test(ch);
}

/**
 * Step 4: single left-to-right scan over the `&`-normalized string, emitting
 * into a fresh buffer (never re-scanning emitted output) so no rule can
 * self-pollute a reference this same pass just produced. `#` is the one
 * exception that needs an explicit guard: it must NOT be re-encoded when it
 * is the literal remainder of a `&#124;`-shaped string that step 3 already
 * neutralized into `&amp;#124;` (checked via the exact 5-char `&amp;` suffix
 * that step 3's substitution — and ONLY step 3's substitution — can produce).
 */
function encodeActiveCharacters(text) {
  let out = "";
  let awaitingAutolinkDot = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (CONTROL_OR_BIDI.test(ch)) {
      out += "<ctrl>";
      i += 1;
      continue;
    }

    if (ch === "\r" || ch === "\n" || ch === "\u2028" || ch === "\u2029") {
      out += " ";
      i += 1;
      continue;
    }

    if ((ch === "h" || ch === "H") && !isWordChar(text[i - 1])) {
      const m = /^https?:/iu.exec(text.slice(i));
      if (m) {
        const scheme = m[0].slice(0, -1);
        out += scheme;
        out += "&#58;";
        i += m[0].length;
        awaitingAutolinkDot = true;
        continue;
      }
    }

    if ((ch === "w" || ch === "W") && !isWordChar(text[i - 1])) {
      const m = /^www\./iu.exec(text.slice(i));
      if (m) {
        out += text.slice(i, i + 3);
        out += "&#46;";
        i += m[0].length;
        awaitingAutolinkDot = false;
        continue;
      }
    }

    if (ch === "." && awaitingAutolinkDot) {
      out += "&#46;";
      awaitingAutolinkDot = false;
      i += 1;
      continue;
    }

    switch (ch) {
      case "|":
        out += "&#124;";
        break;
      case "<":
        out += "&lt;";
        break;
      case "[":
        out += "&#91;";
        break;
      case "]":
        out += "&#93;";
        break;
      case "@":
        out += "&#64;";
        break;
      case "#":
        out += out.endsWith("&amp;") ? "#" : "&#35;";
        break;
      default:
        out += ch;
    }
    i += 1;
  }

  return out;
}

/**
 * sanitizeItem: 淨化 → 截斷 → `&` 正規化 → 其餘字元參考（四步，順序固定，D7）。
 * `item` retains its user-prompt/subagent-description semantics; this only
 * neutralizes markup-injection / autolink surfaces at the output boundary.
 */
export function sanitizeItem(text, { homeDir, itemWidth = 80 } = {}) {
  // F-C3: ENC_CWD_OPEN/ENC_CWD_CLOSE are private-use sentinel codepoints that
  // the final step below unconditionally turns into literal `<`/`>`. If the
  // INPUT text already contains these codepoints (attacker/user-supplied),
  // they are not covered by CONTROL_OR_BIDI and pass through
  // encodeActiveCharacters unchanged, then get turned into unescaped `<`/`>`
  // by the final step — defeating the entire escaping mechanism. Stripping
  // any pre-existing occurrence from the raw input FIRST guarantees the only
  // way these two codepoints can appear in the string handed to the final
  // step is via sanitizeHomeAndCwd's own system-inserted `<enc-cwd>`
  // placeholder, restoring the "not user-controllable" premise design.md D7's
  // F-5-1 residual-risk paragraph relies on.
  const raw = String(text ?? "").replaceAll(ENC_CWD_OPEN, "").replaceAll(ENC_CWD_CLOSE, "");
  const sanitized = sanitizeHomeAndCwd(raw, homeDir);
  const truncated = truncateRaw(sanitized, itemWidth);
  const ampNormalized = truncated.replaceAll("&", "&amp;");
  const encoded = encodeActiveCharacters(ampNormalized);
  return encoded.replaceAll(ENC_CWD_OPEN, "<").replaceAll(ENC_CWD_CLOSE, ">");
}

// ---------------------------------------------------------------------------
// Shared token-aggregation helpers (T2 / T3 / T4)
// ---------------------------------------------------------------------------

/**
 * Collapse a flat list of normalized assistant-message records sharing the
 * same `id` down to ONE record: the terminal row (`stop_reason != null`) if
 * one exists, else the one with the largest `output_tokens` in the group.
 * Shared by main-turn dedup (T2), subagent terminal-row dedup (T3), and the
 * T4 internal-conservation invariant so there is exactly one dedup
 * implementation to get wrong.
 */
export function collapseTerminalMessagesById(messages) {
  const groups = new Map();
  for (const msg of messages) {
    const key = msg.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(msg);
  }
  const result = [];
  for (const group of groups.values()) {
    const terminal = group.find((m) => m.stop_reason != null);
    if (terminal) {
      result.push(terminal);
      continue;
    }
    let best = group[0];
    for (const m of group) {
      if ((m.output_tokens ?? 0) > (best.output_tokens ?? 0)) best = m;
    }
    result.push(best);
  }
  return result;
}

/**
 * Harden collapsed `deduped` (or equivalent message collections) before
 * last-element access (#2627 / D1 / F1).
 *
 * - Array → return as-is
 * - iterable / array-like → Array.from, preserving elements (never silent [])
 * - unconvertible → empty messages + named gap `collapsed-deduped-unconvertible`
 */
export function asMessageArray(value) {
  if (Array.isArray(value)) {
    return { ok: true, messages: value, gap: null };
  }
  if (value != null && (typeof value === "object" || typeof value === "function")) {
    const hasIterator = typeof value[Symbol.iterator] === "function";
    const length = value.length;
    const arrayLike =
      typeof length === "number"
      && Number.isFinite(length)
      && length >= 0
      && length <= Number.MAX_SAFE_INTEGER
      && Math.floor(length) === length;
    if (hasIterator || arrayLike) {
      try {
        return { ok: true, messages: Array.from(value), gap: null };
      } catch {
        // fall through to named gap
      }
    }
  }
  return {
    ok: false,
    messages: [],
    gap: { name: "collapsed-deduped-unconvertible" },
  };
}

function lastMessage(messages) {
  return messages.length ? messages[messages.length - 1] : undefined;
}

function aggregateTokens(deduped) {
  let input = 0;
  let output = 0;
  let cache_read = 0;
  let cache_creation = 0;
  let cache_read_peak = 0;
  for (const m of deduped) {
    input += m.input_tokens ?? 0;
    output += m.output_tokens ?? 0;
    const normalizedCacheRead = m.cache_read_input_tokens ?? 0;
    cache_read += normalizedCacheRead;
    cache_creation += m.cache_creation_input_tokens ?? 0;
    // F-S3: assign the SAME normalized value used for the comparison, not the
    // raw field — otherwise a non-normalized caller (currently latent, since
    // every caller routes through normalizeAssistantMessage first) could
    // produce `undefined` here despite `cache_read_peak` being a numeric
    // field everywhere else in the return shape.
    if (normalizedCacheRead > cache_read_peak) {
      cache_read_peak = normalizedCacheRead;
    }
  }
  return { input, output, cache_read, cache_creation, cache_read_peak };
}

function computeDurationMs(startTs, endTs) {
  if (!startTs || !endTs) return null;
  const start = Date.parse(startTs);
  const end = Date.parse(endTs);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function sum(list, pick) {
  return list.reduce((acc, item) => acc + (pick(item) ?? 0), 0);
}

/** name-only gap entries carry no extra keys; reconciliation gaps carry ledger_total/host_total/delta. */
function reconcileCacheRead({ ledgerTotal, hostTotal, hasHostSource }) {
  if (!hasHostSource) {
    return { fieldAvailability: "unverified-on-host", gap: null };
  }
  if (ledgerTotal === hostTotal) {
    return { fieldAvailability: "available", gap: null };
  }
  return {
    fieldAvailability: "unreconciled",
    gap: {
      name: "cache-read-unreconciled",
      ledger_total: ledgerTotal,
      host_total: hostTotal,
      delta: ledgerTotal - hostTotal,
    },
  };
}

// ---------------------------------------------------------------------------
// Claude Code reader (T2 / T2a / T3 / T4)
// ---------------------------------------------------------------------------

function isToolResultOnly(content) {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => block?.type === "tool_result");
}

/**
 * F-C2: real `type:"user"` records for a genuine typed prompt carry
 * `message.content` as a plain STRING, not an array — arrays only occur for
 * `tool_result` content (optionally mixed with a `text` block). The
 * array-handling branch below is unchanged and still correct for that case.
 */
function firstTextLine(content) {
  if (typeof content === "string") {
    return content.split(/\r?\n/u, 1)[0] ?? "";
  }
  if (!Array.isArray(content)) return "";
  const textBlock = content.find((block) => block?.type === "text");
  const text = textBlock?.text ?? "";
  return String(text).split(/\r?\n/u, 1)[0] ?? "";
}

function extractToolUseIds(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === "tool_use" && b?.id).map((b) => b.id);
}

function normalizeAssistantMessage(record) {
  const message = record.message ?? {};
  const usage = message.usage ?? {};
  return {
    id: message.id,
    model: message.model ?? null,
    stop_reason: message.stop_reason ?? null,
    output_tokens: usage.output_tokens ?? 0,
    input_tokens: usage.input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    toolUseIds: extractToolUseIds(message.content),
    ts: record.timestamp ?? null,
  };
}

// D9 / task 15: only these `type:"system"` subtypes may be walked THROUGH
// while classifying a turn's origin — they record something happened but
// are not themselves one of the three target markers. Any other subtype
// (present or future) is refused rather than silently treated as a
// passthrough, per D9's 理由 (a silently-inflated `user` bucket is a false
// distribution, worse than an honest `unsupported`).
const TURN_ORIGIN_PASSTHROUGH_SUBTYPES = new Set(["turn_duration", "away_summary", "local_command"]);
// Longest real chain observed (task 15 decisions, sample transcript):
// scheduled_task_fire -> turn_duration -> stop_hook_summary = 3 system hops.
// Bounded well above that so a legitimate chain never hits the ceiling,
// while still refusing to walk an unbounded/corrupt chain (NFR-1 spirit).
const TURN_ORIGIN_MAX_HOPS = 8;

/**
 * D9: classify why a main-context turn started, by walking `parentUuid` back
 * through `type:"system"` records the parser otherwise ignores. Returns one
 * of "compaction-continuation" | "wakeup" | "stop-hook" | "user" |
 * "unsupported". Every hop that cannot be resolved with confidence — a
 * broken chain, an unrecognized subtype, or the hop budget running out —
 * MUST return "unsupported", never fall through to "user": a silently
 * inflated `user` bucket is exactly the false distribution D9 warns against.
 * `byUuid` is a `Map<uuid, record>` over the FULL raw record set (every
 * type, not just user/assistant) — the markers this walks live under
 * `type:"system"`.
 */
export function classifyTurnOrigin(parentUuid, byUuid) {
  let cur = parentUuid ?? null;
  if (!cur) return "user"; // no parent at all: turn/session sequence start, not data loss.
  for (let hops = 0; hops < TURN_ORIGIN_MAX_HOPS; hops += 1) {
    const parent = byUuid.get(cur);
    if (!parent) return "unsupported"; // chain breaks — don't guess.
    if (parent.type !== "system") return "user"; // clean walk to a real conversation node.
    const subtype = parent.subtype;
    if (subtype === "compact_boundary") return "compaction-continuation";
    if (subtype === "scheduled_task_fire") return "wakeup";
    if (subtype === "stop_hook_summary") return "stop-hook";
    if (!TURN_ORIGIN_PASSTHROUGH_SUBTYPES.has(subtype)) return "unsupported"; // unrecognized marker — don't guess.
    cur = parent.parentUuid ?? null; // dead-ending here (null) resolves to "unsupported" next iteration via !parent.
  }
  return "unsupported"; // hop budget exhausted — don't guess.
}

/**
 * Turn splitting: a `type:"user"` record starts a new turn UNLESS its content
 * is entirely `tool_result` backfill blocks (T2). `type:"assistant"` records
 * attach to the currently-open turn. D9 / task 15: each turn additionally
 * carries `origin_class`, derived via classifyTurnOrigin from the SAME
 * records array (uuid-indexed once up front) — a main-context-only concept;
 * subagent rows classify separately as `subagent:<agentType>` (see
 * groupTurnsByClass), never through this walk.
 */
export function parseClaudeCodeTurns(records) {
  const byUuid = new Map();
  for (const record of records) {
    if (record?.uuid) byUuid.set(record.uuid, record);
  }
  const rawTurns = [];
  let current = null;
  for (const record of records) {
    if (record?.type === "user") {
      const content = record.message?.content;
      if (!isToolResultOnly(content)) {
        current = {
          ts: record.timestamp ?? null,
          cwd: record.cwd ?? null,
          item: firstTextLine(content),
          parentUuid: record.parentUuid ?? null,
          rawAssistant: [],
        };
        rawTurns.push(current);
      }
      continue;
    }
    if (record?.type === "assistant" && current) {
      current.rawAssistant.push(record);
    }
  }
  return rawTurns.map((turn) => {
    const normalized = turn.rawAssistant.map(normalizeAssistantMessage);
    const collapsed = collapseTerminalMessagesById(normalized);
    const { messages: deduped, gap: hardenGap } = asMessageArray(collapsed);
    const tokens = aggregateTokens(deduped);
    // T10 (strengthen-subagent-delegation-strategy): Claude Code writes one
    // assistant record PER CONTENT BLOCK (same message id, apiBlockIndex 0..n),
    // so collapsing by id keeps only one block's tool_use ids and every other
    // Agent spawn in the same message became `subagent-unattached`. The
    // attachment key is the union across all records of the turn; tokens
    // still come from the collapsed rows.
    const toolUseIds = [...new Set(normalized.flatMap((m) => m.toolUseIds))];
    const last = lastMessage(deduped);
    const lastTs = last ? last.ts : turn.ts;
    return {
      ts: turn.ts,
      cwd: turn.cwd,
      actor: "main",
      item: turn.item,
      duration_ms: computeDurationMs(turn.ts, lastTs),
      tokens,
      toolUseIds,
      children: [],
      origin_class: classifyTurnOrigin(turn.parentUuid, byUuid),
      ...(hardenGap ? { harden_gap: hardenGap } : {}),
    };
  });
}

/**
 * Cost-state reader (T2a). Reads `type:"cost-state"` lines from the SAME
 * transcript JSONL (NOT `~/.claude/stats-cache.json`, which is a
 * cross-session daily aggregate). Only transcribes `totalCostUSD`; MUST NOT
 * compute a cost figure itself (NFR4).
 */
export function extractCostState(records) {
  const list = Array.isArray(records) ? records : [];
  const costStateLines = list.filter((r) => r?.type === "cost-state");
  const modelsInTranscript = new Set(
    list
      .filter((r) => r?.type === "assistant" && r?.message?.model)
      .map((r) => r.message.model),
  );

  if (costStateLines.length === 0) {
    return { cost_usd: null, modelUsage: {}, gaps: [{ name: "no-cost-state" }] };
  }

  const last = costStateLines.at(-1);
  const modelUsage = last.modelUsage ?? {};
  const gaps = [];
  for (const model of Object.keys(modelUsage)) {
    if (!modelsInTranscript.has(model)) {
      gaps.push({ name: "model-absent-from-transcript", model });
    }
  }
  if (last.hasUnknownModelCost) gaps.push({ name: "unknown-model-cost" });

  return { cost_usd: last.totalCostUSD ?? null, modelUsage, gaps };
}

/** Subagent terminal-row reader (T3): meta.json's toolUseId hooks the child back to its turn. */
export function parseSubagentTranscript(meta, records, { sessionId = null } = {}) {
  const list = Array.isArray(records) ? records : [];
  const normalized = list
    .filter((r) => r?.type === "assistant")
    .map(normalizeAssistantMessage);
  const collapsed = collapseTerminalMessagesById(normalized);
  const { messages: deduped, gap: hardenGap } = asMessageArray(collapsed);
  const tokens = aggregateTokens(deduped);
  // T10 (strengthen-subagent-delegation-strategy D13): delegation evidence.
  // A dispatch turn is a `type:"user"` record that is not tool_result-only
  // backfill — the first one is the spawn prompt, later ones are
  // continuations (SendMessage). Only the prompt DIGEST is carried, never the
  // text. Missing meta fields stay null; nothing here is coerced to 0/fresh.
  const dispatchRecords = list.filter((r) => r?.type === "user" && !isToolResultOnly(r.message?.content));
  const promptText = promptTextOf(dispatchRecords[0]?.message?.content);
  const spawnDepth = Number.isInteger(meta?.spawnDepth) ? meta.spawnDepth : null;
  const agentType = typeof meta?.agentType === "string" && meta.agentType ? meta.agentType : null;
  const last = lastMessage(deduped);
  return {
    agent_type: agentType,
    spawn_depth: spawnDepth,
    dispatch_turns: dispatchRecords.length,
    prompt_sha256: promptText ? createHash("sha256").update(promptText).digest("hex") : null,
    start_ts: deduped[0]?.ts ?? null,
    end_ts: last?.ts ?? null,
    session_id: meta?.sessionId ?? meta?.session_id ?? sessionId,
    context_mode: ["fresh", "fork", "resume", "nested"].includes(meta?.contextMode ?? meta?.context_mode ?? meta?.trusted_mode)
      ? (meta.contextMode ?? meta.context_mode ?? meta.trusted_mode)
      : null,
    terminal_message_id: last?.id ?? null,
    actor: meta?.agentType ?? "subagent",
    item: meta?.description ?? "",
    toolUseId: meta?.toolUseId ?? null,
    ts: deduped[0]?.ts ?? null,
    duration_ms: computeDurationMs(deduped[0]?.ts, last?.ts),
    tokens,
    children: [],
    ...(hardenGap ? { harden_gap: hardenGap } : {}),
  };
}

function promptTextOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

function attachSubagents(turns, subagents) {
  for (const turn of turns) {
    for (const subagent of subagents) {
      if (subagent.toolUseId && turn.toolUseIds.includes(subagent.toolUseId)) {
        turn.children.push(subagent);
      }
    }
  }
  return turns;
}

/**
 * Load Claude Code subagent transcripts from `<session>/subagents/`.
 * Supports both on-disk layouts observed in the wild:
 *   - flat files: `agent-<id>.meta.json` + `agent-<id>.jsonl` (current CC CLI)
 *   - nested dirs: `<agentDir>/meta.json` + `transcript.jsonl` (fixture / legacy)
 */
export function loadClaudeCodeSubagents(subagentsDir, readFile, listDir) {
  const subagents = [];
  let failures = 0;
  let entries;
  try {
    entries = listDir(subagentsDir);
  } catch {
    return { subagents, failures };
  }

  const flatMetaFiles = entries.filter((e) => e.startsWith("agent-") && e.endsWith(".meta.json"));
  const flatIds = new Set(flatMetaFiles.map((f) => f.slice("agent-".length, -".meta.json".length)));

  for (const id of flatIds) {
    try {
      const meta = JSON.parse(readFile(path.join(subagentsDir, `agent-${id}.meta.json`)));
      const { records: subRecords } = parseJsonl(readFile(path.join(subagentsDir, `agent-${id}.jsonl`)));
      subagents.push(parseSubagentTranscript(meta, subRecords, { sessionId: id }));
    } catch {
      failures += 1;
    }
  }

  for (const entry of entries) {
    if (entry.endsWith(".jsonl") || entry.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(readFile(path.join(subagentsDir, entry, "meta.json")));
      const { records: subRecords } = parseJsonl(readFile(path.join(subagentsDir, entry, "transcript.jsonl")));
      subagents.push(parseSubagentTranscript(meta, subRecords, { sessionId: entry }));
    } catch {
      failures += 1;
    }
  }

  return { subagents, failures };
}

function appendUnattachedSubagentTurns(turns, subagents) {
  const attachedToolUseIds = new Set();
  for (const turn of turns) {
    for (const child of turn.children ?? []) {
      if (child.toolUseId) attachedToolUseIds.add(child.toolUseId);
    }
  }
  for (const sub of subagents) {
    if (!sub.toolUseId || attachedToolUseIds.has(sub.toolUseId)) continue;
    turns.push({
      ts: sub.ts,
      cwd: null,
      actor: sub.actor,
      item: sub.item,
      duration_ms: sub.duration_ms,
      tokens: sub.tokens,
      toolUseIds: [],
      children: [],
    });
  }
  return turns;
}

// Visibility widened to `export` for `--since-change` (design.md D7 F-4-1 /
// F-5-1 aggregation) to reuse verbatim on a `start_ts`/transition-bounded
// turns subset, rather than re-deriving flattening/summing logic a second
// time. Pure widening — behavior unchanged, still module-internal callers too.
export function flattenRows(turns) {
  const rows = [];
  for (const turn of turns) {
    rows.push(turn);
    for (const child of turn.children ?? []) rows.push(child);
  }
  return rows;
}

export function totalsFrom(rows, field) {
  return sum(rows, (r) => r.tokens[field]);
}

function diagnosticTotalsFrom(rows, field) {
  const observedRows = rows.filter((row) => Number.isSafeInteger(row?.tokens?.[field]));
  return observedRows.length === 0 ? null : totalsFrom(observedRows, field);
}

const TURN_CLASS_TOKEN_FIELDS = ["input", "output", "cache_read", "cache_creation"];

/**
 * D9 / task 15 (R7): `--by-class` derivation. Groups flattened turn rows by
 * class — `subagent:<agentType>` for any row not on the main actor (the
 * existing attachSubagents-derived actor already IS the class, unchanged by
 * this task); for main-context rows, `row.origin_class` (set by
 * parseClaudeCodeTurns via classifyTurnOrigin). A main-context row with no
 * `origin_class` — the Codex read path never sets it, since the
 * parentUuid/system-marker scheme is Claude-Code-transcript-specific —
 * resolves to `unsupported` by the same `?? "unsupported"` fallback, with no
 * host special-casing: an unclassifiable row is unsupported whether the
 * cause is a Claude-Code chain anomaly or an entire non-Claude-Code host.
 */
export function groupTurnsByClass(turns) {
  const groups = {};
  const bump = (cls, row) => {
    if (!groups[cls]) {
      groups[cls] = { count: 0, tokens: Object.fromEntries(TURN_CLASS_TOKEN_FIELDS.map((f) => [f, 0])) };
    }
    groups[cls].count += 1;
    for (const field of TURN_CLASS_TOKEN_FIELDS) {
      groups[cls].tokens[field] += row.tokens?.[field] ?? 0;
    }
  };
  for (const row of flattenRows(turns)) {
    const cls = row.actor === "main" ? (row.origin_class ?? "unsupported") : `subagent:${row.actor}`;
    bump(cls, row);
  }
  return groups;
}

function listMainTranscriptFiles(root, listDir) {
  const projectsDir = path.join(root, "projects");
  const projectDirs = listDir(projectsDir);
  const files = [];
  for (const projectDir of projectDirs) {
    const projectPath = path.join(projectsDir, projectDir);
    let entries;
    try {
      entries = listDir(projectPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) {
        files.push({ file: path.join(projectPath, entry), sessionId: entry.slice(0, -".jsonl".length) });
      }
    }
  }
  return files;
}

function discoverClaudeCodeSession({ root, sessionId, latest, cwdRoots, readFile, listDir, realpath }) {
  let files;
  try {
    files = listMainTranscriptFiles(root, listDir);
  } catch {
    return { error: "host root not found" };
  }

  if (sessionId) {
    const match = files.find((f) => f.sessionId === sessionId);
    if (!match) return { error: "session not found" };
    return { file: match.file, sessionId, source: "exact" };
  }

  if (latest) {
    const candidates = [];
    for (const f of files) {
      let content;
      try {
        content = readFile(f.file);
      } catch {
        continue;
      }
      // F-C1c: probe only, never retain `content` in `candidates` — real
      // transcripts can be large and many may match once F-I6 widened
      // cwdRoots to every worktree of this repo; retaining every matching
      // candidate's full content is what exhausted the heap (see
      // scanLeadingRecords docblock). The winner is re-read once below.
      const cwd = scanLeadingRecords(content, 50, (record) => record?.cwd ?? null);
      if (!matchesCwdRoots(cwd, cwdRoots, realpath)) continue;
      const lastRecord = lastParseableJsonLine(content);
      candidates.push({ ...f, lastTs: lastRecord?.timestamp ?? "" });
    }
    if (candidates.length === 0) return { error: "no session found" };
    candidates.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
    const picked = candidates[0];
    return { file: picked.file, sessionId: picked.sessionId, source: "latest-fallback" };
  }

  return { error: "no session specified" };
}

/**
 * @param {object} options
 * @param {string} options.root - injected `~/.claude`-equivalent root
 * @param {string} [options.homeDir]
 * @param {string} [options.sessionId]
 * @param {boolean} [options.latest]
 * @param {string[]} [options.cwdRoots]
 * @param {(p:string)=>string} [options.readFile]
 * @param {(p:string)=>string[]} [options.listDir]
 * @param {(p:string)=>string} [options.realpath]
 * @param {(dir:string)=>string[]} [options.listSubagents] - subagent id dirs under `<sessionId>/subagents/`
 */
export function readClaudeCodeSession({
  root,
  sessionId,
  latest,
  cwdRoots = [],
  readFile = defaultReadFile,
  listDir = defaultListDir,
  realpath = defaultRealpath,
  fileSize = defaultFileSize,
} = {}) {
  const rootCheck = ensureHostRoot({ root, listDir });
  if (!rootCheck.available) return rootCheck;

  if (sessionId !== undefined && sessionId !== null && sessionId !== "" && !isValidSessionIdShape(sessionId)) {
    return { available: false, reason: "invalid session id shape" };
  }

  const discovery = discoverClaudeCodeSession({ root, sessionId, latest, cwdRoots, readFile, listDir, realpath });
  if (discovery.error) return { available: false, reason: discovery.error };

  const transcript = readTranscript(discovery.file, { readFile, fileSize, preloadedContent: discovery.preloadedContent });
  if (transcript.error) return { available: false, reason: transcript.error };
  const content = transcript.content;
  const { records, malformedCount } = parseJsonl(content);
  const turns = parseClaudeCodeTurns(records);
  const costState = extractCostState(records);

  const subagents = [];
  let subagentReadFailures = 0;
  const sessionSubagentsDir = path.join(root, "projects");
  // Subagents live under <project-dir>/<sessionId>/subagents/ — flat agent-*.jsonl
  // files or nested <agentDir>/{meta.json,transcript.jsonl} (see loadClaudeCodeSubagents).
  try {
    const projectDirs = listDir(sessionSubagentsDir);
    for (const projectDir of projectDirs) {
      const subagentsDir = path.join(sessionSubagentsDir, projectDir, discovery.sessionId, "subagents");
      const loaded = loadClaudeCodeSubagents(subagentsDir, readFile, listDir);
      subagents.push(...loaded.subagents);
      subagentReadFailures += loaded.failures;
    }
  } catch {
    // no subagents directory at all: fine, subagents stays empty.
  }

  attachSubagents(turns, subagents);
  appendUnattachedSubagentTurns(turns, subagents);
  const rows = flattenRows(turns);
  const rootRows = turns.filter((turn) => turn.actor === "main");

  const totals = {
    input: totalsFrom(rows, "input"),
    output: totalsFrom(rows, "output"),
    cache_read: totalsFrom(rows, "cache_read"),
    cache_creation: totalsFrom(rows, "cache_creation"),
  };
  const lineageRootTotals = {
    input: totalsFrom(rootRows, "input"),
    output: totalsFrom(rootRows, "output"),
    cache_read: totalsFrom(rootRows, "cache_read"),
    cache_creation: totalsFrom(rootRows, "cache_creation"),
  };

  const hasCostState = !costState.gaps.some((g) => g.name === "no-cost-state");
  const hostCacheRead = hasCostState
    ? sum(Object.values(costState.modelUsage), (m) => m.cacheReadInputTokens)
    : null;
  const reconciliation = reconcileCacheRead({
    ledgerTotal: totals.cache_read,
    hostTotal: hostCacheRead,
    hasHostSource: hasCostState,
  });

  const gaps = [...costState.gaps];
  if (reconciliation.gap) gaps.push(reconciliation.gap);
  // F-C4: a malformed trailing line degrades (named gap), never crashes.
  if (malformedCount > 0) gaps.push({ name: "malformed-jsonl-line", count: malformedCount });
  // F-PR-SUBAGENT: subagent dirs that exist but fail read/parse MUST be named.
  if (subagentReadFailures > 0) gaps.push({ name: "subagent-read-failed", count: subagentReadFailures });
  for (const turn of turns) {
    if (turn.harden_gap) gaps.push(turn.harden_gap);
    for (const child of turn.children ?? []) {
      if (child.harden_gap) gaps.push(child.harden_gap);
    }
  }
  for (const subagent of subagents) {
    if (subagent.harden_gap) gaps.push(subagent.harden_gap);
  }
  const missingToolUseId = subagents.filter((s) => !s.toolUseId);
  if (missingToolUseId.length > 0) {
    gaps.push({ name: "subagent-missing-tool-use-id", count: missingToolUseId.length });
  }
  const attachedToolUseIds = new Set();
  for (const turn of turns) {
    for (const child of turn.children ?? []) {
      if (child.toolUseId) attachedToolUseIds.add(child.toolUseId);
    }
  }
  const unattached = subagents.filter((s) => s.toolUseId && !attachedToolUseIds.has(s.toolUseId));
  if (unattached.length > 0) gaps.push({ name: "subagent-unattached", count: unattached.length });

  const lineageRelationships = subagents
    .filter((subagent) => subagent.session_id && subagent.toolUseId && attachedToolUseIds.has(subagent.toolUseId))
    .map((subagent) => ({
      session_id: subagent.session_id,
      trusted_mode: subagent.context_mode,
      terminal_message_id: subagent.terminal_message_id,
      agent_type: subagent.agent_type ?? null,
      spawn_depth: subagent.spawn_depth ?? null,
      dispatch_turns: Number.isInteger(subagent.dispatch_turns) ? subagent.dispatch_turns : null,
      prompt_sha256: subagent.prompt_sha256 ?? null,
      start_ts: subagent.start_ts ?? null,
      end_ts: subagent.end_ts ?? null,
      usage: {
        available: true,
        session: subagent.session_id,
        totals: { ...subagent.tokens },
        cost_usd: null,
        gaps: [],
        terminality: "unknown",
        field_availability: {
          input: "available",
          output: "available",
          cache_read: "available",
          cache_creation: "available",
          cost_usd: "unverified-on-host",
        },
      },
    }));

  return {
    available: true,
    session: discovery.sessionId,
    source: discovery.source,
    cost_usd: costState.cost_usd,
    turns,
    totals,
    gaps,
    lineage_root_usage: {
      available: true,
      session: discovery.sessionId,
      totals: lineageRootTotals,
      cost_usd: costState.cost_usd,
      gaps: [],
      terminality: "unknown",
      field_availability: {
        input: "available",
        output: "available",
        cache_creation: "available",
        cost_usd: costState.cost_usd === null ? "unverified-on-host" : "available",
        cache_read: reconciliation.fieldAvailability,
      },
    },
    lineage_relationships: lineageRelationships,
    field_availability: {
      input: "available",
      output: "available",
      cache_creation: "available",
      // F-I2: Claude Code DOES support cost_usd (totalCostUSD) — a null value
      // here means THIS session had zero cost-state records, not that the
      // host lacks the capability. "available" would misrepresent that.
      cost_usd: costState.cost_usd === null ? "unverified-on-host" : "available",
      cache_read: reconciliation.fieldAvailability,
    },
  };
}

// ---------------------------------------------------------------------------
// Codex reader (T5 / T6)
// ---------------------------------------------------------------------------

export function resolveCodexSessionId(env) {
  const value = env?.CODEX_SESSION_ID;
  return isValidSessionIdShape(value) ? value : null;
}

/** Real Codex rollout token-usage record: `{ type: "event_msg", payload: {
 * type: "token_count", info: {...} | null } }` — nested one level deeper than
 * the original T5 design text assumed (F-C1b). `payload.info` MAY be `null`
 * (e.g. the very first token_count event of a session); such records carry no
 * usage data and MUST be skipped, not normalized into a phantom zero-token
 * row. */
function isCodexTokenCountRecord(record) {
  return record?.type === "event_msg" && record?.payload?.type === "token_count" && Boolean(record.payload.info);
}

function codexTokenCountRecordToRow(record) {
  const info = record.payload.info;
  const last = info.last_token_usage ?? {};
  const inputTokens = last.input_tokens ?? 0;
  const cachedInputTokens = last.cached_input_tokens ?? 0;
  const outputTokens = last.output_tokens ?? 0;
  const reasoningOutputTokens = last.reasoning_output_tokens ?? 0;
  const cacheWriteInputTokens = last.cache_write_input_tokens ?? 0;
  return {
    ts: record.timestamp ?? null,
    actor: "main",
    // Fixture-only label when no turn boundaries exist in the rollout file.
    item: record.payload.item ?? "",
    tokens: {
      input: inputTokens - cachedInputTokens,
      output: outputTokens,
      cache_read: cachedInputTokens,
      cache_creation: null,
      cache_read_peak: null,
      reasoning: reasoningOutputTokens,
    },
    raw: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, cacheWriteInputTokens },
    children: [],
    duration_ms: null,
  };
}

export function parseCodexTokenCountEvents(records) {
  const events = (Array.isArray(records) ? records : []).filter(isCodexTokenCountRecord);
  const rows = events.map(codexTokenCountRecordToRow);
  const totalUsage = events.at(-1)?.payload?.info?.total_token_usage ?? null;
  return { rows, totalUsage, events };
}

const CODEX_USAGE_COUNTER_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function isCodexTokenUsageRecord(record) {
  return record?.type === "token_usage_record";
}

function normalizeCodexUsageCounters(value) {
  const counters = {};
  const invalidMetrics = [];
  for (const key of CODEX_USAGE_COUNTER_KEYS) {
    const counter = value?.[key];
    if (Number.isSafeInteger(counter) && counter >= 0) counters[key] = counter;
    else invalidMetrics.push(key);
  }
  return { counters, invalidMetrics };
}

function codexTokenUsageRecordToEvidence(record, order) {
  const payload = record.payload ?? {};
  const usage = normalizeCodexUsageCounters(payload.usage);
  const cumulative = normalizeCodexUsageCounters(payload.thread_token_usage);
  const turnUsage = normalizeCodexUsageCounters(payload.turn_token_usage);
  return {
    kind: "record",
    order,
    ts: record.timestamp ?? null,
    threadId: typeof payload.thread_id === "string" && payload.thread_id.trim() ? payload.thread_id.trim() : null,
    responseId: typeof payload.response_id === "string" && payload.response_id.trim() ? payload.response_id.trim() : null,
    turnId: typeof payload.turn_id === "string" && payload.turn_id.trim() ? payload.turn_id.trim() : null,
    usage: usage.counters,
    invalidUsageMetrics: usage.invalidMetrics,
    threadUsage: cumulative.counters,
    invalidThreadUsageMetrics: cumulative.invalidMetrics,
    turnUsage: turnUsage.counters,
    invalidTurnUsageMetrics: turnUsage.invalidMetrics,
  };
}

function usageCountersEqual(left, right, leftInvalid = [], rightInvalid = []) {
  return CODEX_USAGE_COUNTER_KEYS.every((key) => left?.[key] === right?.[key]) &&
    CODEX_USAGE_COUNTER_KEYS.every((key) => leftInvalid.includes(key) === rightInvalid.includes(key));
}

function codexRecordCountersToSessionTotals(counters) {
  const input = Number.isSafeInteger(counters?.input_tokens) && Number.isSafeInteger(counters?.cached_input_tokens)
    ? counters.input_tokens - counters.cached_input_tokens
    : null;
  return {
    input,
    output: Number.isSafeInteger(counters?.output_tokens) ? counters.output_tokens : null,
    cache_read: Number.isSafeInteger(counters?.cached_input_tokens) ? counters.cached_input_tokens : null,
    cache_creation: null,
  };
}

function codexRecordUsageToSessionTokens(usage, invalidMetrics = [], conflictedMetrics = []) {
  const invalid = new Set([...invalidMetrics, ...conflictedMetrics]);
  const isValid = (key) => !invalid.has(key) && Number.isSafeInteger(usage?.[key]) && usage[key] >= 0;
  const inputValid = isValid("input_tokens") && isValid("cached_input_tokens");
  return {
    input: inputValid ? usage.input_tokens - usage.cached_input_tokens : null,
    output: isValid("output_tokens") ? usage.output_tokens : null,
    cache_read: isValid("cached_input_tokens") ? usage.cached_input_tokens : null,
    cache_creation: null,
    reasoning: isValid("reasoning_output_tokens") ? usage.reasoning_output_tokens : null,
  };
}

function buildCodexRecordUsage(records, rootThreadId) {
  const byThread = new Map();
  const gaps = [];
  const gapKeys = new Set();
  const unknownThreadEvents = [];
  const unresolvedResponseEvents = [];
  const addGap = (gap, segment = null, threadId = null) => {
    if (segment) segment.gapNames.add(gap.name);
    const threadAttribution = threadId === null
      ? null
      : !rootThreadId
        ? "unresolved"
        : threadId === rootThreadId
          ? "root"
          : "foreign";
    const key = `${gap.name}:${(gap.metrics ?? []).join(",")}:${threadAttribution ?? "unattributed"}`;
    if (gapKeys.has(key)) return;
    gapKeys.add(key);
    gaps.push(threadAttribution ? { ...gap, thread_attribution: threadAttribution } : gap);
  };
  const newSegment = (thread, order, timestamp, resetBoundary = false) => {
    const segment = {
      segmentIndex: thread.segments.length,
      resetBoundary,
      firstOrdinal: order,
      lastOrdinal: order,
      firstTimestamp: timestamp,
      lastTimestamp: timestamp,
      responseIds: [],
      duplicateCount: 0,
      invalidUsageMetrics: new Set(),
      invalidThreadUsageMetrics: new Set(),
      conflictedMetrics: new Set(),
      gapNames: new Set(),
      cumulative: null,
    };
    thread.segments.push(segment);
    return segment;
  };

  for (const record of records) {
    if (!record.threadId) {
      addGap({ name: "codex-thread-identity-unresolved" });
      unknownThreadEvents.push({
        ts: record.ts,
        order: record.order,
        tokens: codexRecordUsageToSessionTokens(record.usage, record.invalidUsageMetrics),
      });
      continue;
    }
    let thread = byThread.get(record.threadId);
    if (!thread) {
      thread = { segments: [], responses: new Map(), lastCumulative: null, reset: false };
      byThread.set(record.threadId, thread);
    }

    const resetMetrics = CODEX_USAGE_COUNTER_KEYS.filter((key) =>
      Number.isSafeInteger(thread.lastCumulative?.[key]) &&
      Number.isSafeInteger(record.threadUsage[key]) &&
      record.threadUsage[key] < thread.lastCumulative[key]);
    if (resetMetrics.length > 0) {
      thread.reset = true;
      addGap({ name: "codex-usage-mixed-unresolved", reason: "cumulative-reset", metrics: resetMetrics }, null, record.threadId);
    }
    if (thread.segments.length === 0 || resetMetrics.length > 0) {
      newSegment(thread, record.order, record.ts, resetMetrics.length > 0);
    }
    const segment = thread.segments[thread.segments.length - 1];
    segment.lastOrdinal = record.order;
    segment.lastTimestamp = record.ts;
    segment.invalidUsageMetrics = new Set([...segment.invalidUsageMetrics, ...record.invalidUsageMetrics]);
    segment.invalidThreadUsageMetrics = new Set([...segment.invalidThreadUsageMetrics, ...record.invalidThreadUsageMetrics]);
    segment.cumulative = record.threadUsage;

    if (record.invalidUsageMetrics.length > 0) {
      addGap({ name: "codex-usage-value-invalid", metrics: record.invalidUsageMetrics }, segment, record.threadId);
    }
    if (record.invalidThreadUsageMetrics.length > 0) {
      addGap({ name: "codex-usage-cumulative-missing", metrics: record.invalidThreadUsageMetrics }, segment, record.threadId);
    }
    if (Number.isSafeInteger(record.usage.cache_write_input_tokens) && record.usage.cache_write_input_tokens !== 0) {
      addGap({ name: "cache-write-input-tokens-nonzero" }, segment, record.threadId);
    }
    if (!record.responseId) {
      segment.invalidUsageMetrics = new Set([...segment.invalidUsageMetrics, ...CODEX_USAGE_COUNTER_KEYS]);
      addGap({ name: "codex-response-identity-unresolved" }, segment, record.threadId);
      unresolvedResponseEvents.push({
        threadId: record.threadId,
        ts: record.ts,
        order: record.order,
        turnId: record.turnId,
        tokens: codexRecordUsageToSessionTokens(record.usage, record.invalidUsageMetrics),
      });
      thread.lastCumulative = record.threadUsage;
      continue;
    }

    const previous = thread.responses.get(record.responseId);
    if (!previous) {
      const response = {
        usage: record.usage,
        invalidMetrics: new Set(record.invalidUsageMetrics),
        conflictedMetrics: new Set(),
        segment,
        event: record,
      };
      thread.responses.set(record.responseId, response);
      segment.responseIds.push(record.responseId);
    } else if (usageCountersEqual(previous.usage, record.usage, [...previous.invalidMetrics], record.invalidUsageMetrics)) {
      segment.duplicateCount += 1;
      if (!previous.event.turnId && record.turnId) previous.event = record;
      else if (previous.event.turnId && record.turnId && previous.event.turnId !== record.turnId) {
        previous.event = { ...previous.event, turnId: null };
        addGap({ name: "codex-response-turn-conflict" }, segment, record.threadId);
      }
    } else {
      const conflictMetrics = CODEX_USAGE_COUNTER_KEYS.filter((key) =>
        previous.usage[key] !== record.usage[key] || previous.invalidMetrics.has(key) !== record.invalidUsageMetrics.includes(key));
      for (const key of conflictMetrics) {
        previous.conflictedMetrics.add(key);
        previous.segment.conflictedMetrics.add(key);
        segment.conflictedMetrics.add(key);
      }
      addGap({ name: "codex-response-usage-conflict", metrics: conflictMetrics }, segment, record.threadId);
    }
    thread.lastCumulative = record.threadUsage;
  }

  for (const [threadId, thread] of byThread) {
    for (const segment of thread.segments) {
      const rawTotals = {};
      const mismatches = [];
      for (const key of CODEX_USAGE_COUNTER_KEYS) {
        let total = 0;
        let invalid = segment.invalidUsageMetrics.has(key) || segment.invalidThreadUsageMetrics.has(key) || segment.conflictedMetrics.has(key);
        for (const responseId of segment.responseIds) {
          const response = thread.responses.get(responseId);
          if (response.invalidMetrics.has(key) || response.conflictedMetrics.has(key)) {
            invalid = true;
            continue;
          }
          total += response.usage[key];
        }
        rawTotals[key] = invalid ? null : total;
        if (!invalid && Number.isSafeInteger(segment.cumulative?.[key]) && total !== segment.cumulative[key]) {
          mismatches.push(key);
        }
      }
      segment.rawTotals = rawTotals;
      const gapBlocksReconciliation = [...segment.gapNames].some((name) =>
        classifySessionUsageGap({ name }, { domain: "codex-metering" }).reconciliation !== "preserve");
      segment.status = mismatches.length === 0 && !gapBlocksReconciliation ? "reconciled" : "unverified";
      if (mismatches.length > 0) {
        addGap({ name: "codex-usage-cumulative-mismatch", metrics: mismatches }, segment, threadId);
        segment.status = "unverified";
      }
      if (segment.status !== "reconciled") segment.status = "unverified";
    }
  }

  const rows = [];
  for (const [threadId, thread] of byThread) {
    for (const [responseId, response] of thread.responses) {
      const event = response.event;
      rows.push({
        threadId,
        responseId,
        turnId: event.turnId,
        segmentIndex: response.segment.segmentIndex,
        order: event.order,
        row: {
          ts: event.ts,
          actor: "main",
          item: "",
          duration_ms: null,
          tokens: codexRecordUsageToSessionTokens(response.usage, response.invalidMetrics, response.conflictedMetrics),
          raw: {
            cacheWriteInputTokens: Number.isSafeInteger(response.usage.cache_write_input_tokens) &&
              !response.invalidMetrics.has("cache_write_input_tokens") &&
              !response.conflictedMetrics.has("cache_write_input_tokens")
              ? response.usage.cache_write_input_tokens
              : null,
          },
          children: [],
        },
      });
    }
  }
  rows.sort((left, right) => left.order - right.order);

  return { byThread, gaps, rows, unknownThreadEvents, unresolvedResponseEvents };
}

function codexCountersToSessionTotals(counters) {
  return codexRecordCountersToSessionTotals(counters ?? {});
}

function codexLegacyCumulativeToSessionTotals(cumulative) {
  if (!cumulative || typeof cumulative !== "object") return null;
  return {
    input: Number.isSafeInteger(cumulative.input_tokens) && Number.isSafeInteger(cumulative.cached_input_tokens)
      ? cumulative.input_tokens - cumulative.cached_input_tokens
      : null,
    output: Number.isSafeInteger(cumulative.output_tokens) ? cumulative.output_tokens : null,
    cache_read: Number.isSafeInteger(cumulative.cached_input_tokens) ? cumulative.cached_input_tokens : null,
    cache_creation: null,
  };
}

function buildCodexLegacyUsageSegments(usageEvents, preserveLegacyTotals) {
  const segments = [];
  let current = null;
  let previousCumulative = null;
  const gaps = [];
  for (const event of usageEvents) {
    if (event.kind !== "legacy") continue;
    const resetMetrics = Object.keys(event.cumulative ?? {}).filter((key) =>
      Number.isSafeInteger(previousCumulative?.[key]) &&
      Number.isSafeInteger(event.cumulative[key]) &&
      event.cumulative[key] < previousCumulative[key]);
    if (resetMetrics.length > 0) {
      gaps.push({ name: "codex-usage-mixed-unresolved", reason: "cumulative-reset", metrics: resetMetrics });
    }
    if (!current || resetMetrics.length > 0) {
      current = {
        source: "legacy-token-count",
        thread_attribution: "root",
        reset_boundary: resetMetrics.length > 0,
        first_ordinal: event.order,
        last_ordinal: event.order,
        first_ts: event.ts,
        last_ts: event.ts,
        event_count: 0,
        input: 0,
        output: 0,
        cache_read: 0,
        cumulative: null,
      };
      segments.push(current);
    }
    current.last_ordinal = event.order;
    current.last_ts = event.ts;
    current.event_count += 1;
    current.input += event.row.tokens.input ?? 0;
    current.output += event.row.tokens.output ?? 0;
    current.cache_read += event.row.tokens.cache_read ?? 0;
    current.cumulative = codexLegacyCumulativeToSessionTotals(event.cumulative);
    if (event.cumulative && typeof event.cumulative === "object") previousCumulative = event.cumulative;
  }
  return {
    hasReset: gaps.length > 0,
    gaps,
    segments: segments.map((segment) => ({
      source: segment.source,
      thread_attribution: segment.thread_attribution,
      reset_boundary: segment.reset_boundary,
      first_ordinal: segment.first_ordinal,
      last_ordinal: segment.last_ordinal,
      first_ts: segment.first_ts,
      last_ts: segment.last_ts,
      event_count: segment.event_count,
      totals: preserveLegacyTotals && segments.length === 1
        ? preserveLegacyTotals
        : { input: segment.input, output: segment.output, cache_read: segment.cache_read, cache_creation: null },
      cumulative: segment.cumulative,
      reconciliation: "legacy",
    })),
  };
}

function buildCodexUsageAccounting({ usageEvents, rootThreadId, legacyTotals }) {
  const orderedEvents = [...usageEvents].sort((left, right) => left.order - right.order);
  const recordEvents = usageEvents.filter((event) => event.kind === "record");
  const legacyEvents = usageEvents.filter((event) => event.kind === "legacy");
  const recordUsage = buildCodexRecordUsage(recordEvents, rootThreadId);
  const rootThread = rootThreadId ? recordUsage.byThread.get(rootThreadId) : null;
  const rootRecordEvents = rootThreadId ? recordEvents.filter((event) => event.threadId === rootThreadId) : [];
  const hasLegacy = legacyEvents.length > 0;
  const hasRootRecords = rootRecordEvents.length > 0;
  const sourceSegments = [];

  const legacyUsage = buildCodexLegacyUsageSegments(
    orderedEvents,
    hasRootRecords ? null : legacyTotals,
  );
  sourceSegments.push(...legacyUsage.segments);

  for (const [threadId, thread] of recordUsage.byThread) {
    const attribution = !rootThreadId ? "unresolved" : threadId === rootThreadId ? "root" : "foreign";
    for (const segment of thread.segments) {
      sourceSegments.push({
        source: "token-usage-record",
        thread_attribution: attribution,
        segment_index: segment.segmentIndex,
        reset_boundary: segment.resetBoundary,
        first_ordinal: segment.firstOrdinal,
        last_ordinal: segment.lastOrdinal,
        first_ts: segment.firstTimestamp,
        last_ts: segment.lastTimestamp,
        response_count: segment.responseIds.length,
        duplicate_count: segment.duplicateCount,
        raw_usage_totals: segment.rawTotals,
        raw_thread_cumulative: segment.cumulative,
        totals: codexCountersToSessionTotals(segment.rawTotals),
        cumulative: codexCountersToSessionTotals(segment.cumulative),
        reconciliation: segment.status,
        gaps: [...segment.gapNames],
      });
    }
  }
  sourceSegments.sort((left, right) => left.last_ordinal - right.last_ordinal);

  const hasReset = Boolean(rootThread?.reset || legacyUsage.hasReset);
  const unresolvedMix = hasLegacy && hasRootRecords || hasReset;
  const usageSource = unresolvedMix
    ? "mixed-unresolved"
    : hasRootRecords
      ? "token-usage-record"
      : hasLegacy
        ? "legacy-token-count"
        : null;
  const gaps = [...recordUsage.gaps, ...legacyUsage.gaps];
  if (hasLegacy && hasRootRecords && !gaps.some((gap) =>
    gap.name === "codex-usage-mixed-unresolved" && gap.thread_attribution !== "foreign")) {
    gaps.push({ name: "codex-usage-mixed-unresolved" });
  }
  const gapBlocksRootReconciliation = gaps.some((gap) => gap.thread_attribution !== "foreign" &&
    classifySessionUsageGap(gap, { domain: "codex-metering" }).reconciliation !== "preserve");

  const rootSegments = sourceSegments.filter((segment) => segment.thread_attribution === "root");
  const latestRootSegment = rootSegments.length > 0 ? rootSegments[rootSegments.length - 1] : null;
  const totals = usageSource === "legacy-token-count"
    ? legacyTotals
    : latestRootSegment?.totals ?? (!rootThreadId && recordEvents.length > 0 && !hasLegacy
      ? { input: null, output: null, cache_read: null, cache_creation: null }
      : legacyTotals);
  const hostTotals = latestRootSegment?.cumulative ?? null;
  const rootRecordSegments = rootThread?.segments ?? [];
  const rootRecordGapBlocksReconciliation = rootRecordSegments.some((segment) => [...segment.gapNames].some((name) =>
    classifySessionUsageGap({ name }, { domain: "codex-metering" }).reconciliation !== "preserve"));
  const recordStatus = !rootRecordGapBlocksReconciliation && !gapBlocksRootReconciliation &&
    hasRootRecords && !unresolvedMix && rootRecordSegments.length > 0 &&
    rootRecordSegments.every((segment) => segment.status === "reconciled")
    ? "reconciled"
    : hasRootRecords || unresolvedMix || rootRecordGapBlocksReconciliation || gapBlocksRootReconciliation
      ? "unverified"
      : null;

  return {
    usage_source: usageSource,
    usage_segments: sourceSegments,
    usage_reconciliation: recordStatus ? { status: recordStatus } : null,
    totals,
    hostTotals,
    gaps,
    has_record_events: recordEvents.length > 0,
    has_root_record_events: hasRootRecords,
    mixed: unresolvedMix,
    selected_root_segment: latestRootSegment,
    root_record_rows: latestRootSegment?.source === "token-usage-record"
      ? recordUsage.rows.filter((row) => row.threadId === rootThreadId && row.segmentIndex === latestRootSegment.segment_index)
      : [],
    unknown_thread_events: recordUsage.unknownThreadEvents,
    unknown_response_events: rootThreadId
      ? recordUsage.unresolvedResponseEvents.filter((event) => event.threadId === rootThreadId)
      : [],
  };
}

const CODEX_SYSTEM_USER_PREFIXES = [
  "<recommended_plugins>",
  "<skills_instructions>",
  "<environment_context>",
  "<codex_internal_context",
  "<developer_instructions>",
  "# AGENTS",
];

function isCodexSystemUserText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return true;
  if (CODEX_SYSTEM_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  if (/^Continue working toward the active thread goal/im.test(trimmed)) return true;
  return false;
}

function firstCodexUserPromptLine(text) {
  const joined = String(text ?? "").trim();
  if (!joined || isCodexSystemUserText(joined)) return "";
  return joined.split(/\r?\n/u, 1)[0] ?? "";
}

function extractCodexUserItemText(payload) {
  if (payload?.type !== "message" || payload?.role !== "user") return "";
  const content = payload.content;
  const texts = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "input_text" || block?.type === "text") {
        texts.push(block.text ?? "");
      }
    }
  }
  return firstCodexUserPromptLine(texts.join("\n"));
}

function extractCodexUserMessageEventText(payload) {
  if (payload?.type !== "user_message") return "";
  const raw = payload.message ?? payload.text ?? payload.content ?? "";
  if (typeof raw === "string") return firstCodexUserPromptLine(raw);
  if (Array.isArray(raw)) {
    const texts = [];
    for (const block of raw) {
      if (typeof block === "string") texts.push(block);
      else if (block?.type === "input_text" || block?.type === "text") texts.push(block.text ?? "");
    }
    return firstCodexUserPromptLine(texts.join("\n"));
  }
  return "";
}

function extractSpawnAgentType(payload) {
  if (payload?.type !== "function_call" || payload?.name !== "spawn_agent") {
    return { observed: false, agentType: null, malformed: false };
  }
  try {
    const args = JSON.parse(payload.arguments ?? "{}");
    const agentType = args.agent_type ?? args.agentType;
    return {
      observed: true,
      agentType: typeof agentType === "string" && agentType.trim() ? agentType.trim() : null,
      // T29 (strengthen-subagent-delegation-strategy): the context mode of a
      // Codex spawn is carried only by the parent's arguments — Multi-Agent v2
      // `fork_turns` ("none" | "1".."6" | "all") or the legacy boolean
      // `fork_context`. Carried verbatim; the lineage layer maps it, never infers a default.
      forkTurns: typeof args.fork_turns === "string" ? args.fork_turns : null,
      forkContext: typeof args.fork_context === "boolean" ? args.fork_context : null,
      malformed: false,
    };
  } catch {
    return { observed: true, agentType: null, forkTurns: null, forkContext: null, malformed: true };
  }
}

/**
 * T29: `spawn_agent`'s function_call_output is `{"task_name":"/root/<task>"}`
 * (codex-cli 0.152.1 live fixture `codex-continuation-followup-task.json`);
 * that path equals the child's `session_meta.payload.source.subagent
 * .thread_spawn.agent_path`, which is the only join between a parent spawn
 * call and its child rollout. Anything else yields null (no guessing).
 */
function extractSpawnOutputAgentPath(output) {
  if (typeof output !== "string" || !output) return null;
  try {
    const parsed = JSON.parse(output);
    return typeof parsed?.task_name === "string" && parsed.task_name ? parsed.task_name : null;
  } catch {
    return null;
  }
}

const CODEX_CONTINUATION_TOOL = "followup_task";

function aggregateCodexTokenRows(rows) {
  let input = 0;
  let output = 0;
  let cache_read = 0;
  let reasoning = 0;
  let cacheWriteInputTokens = 0;
  for (const row of rows) {
    input += row.tokens?.input ?? 0;
    output += row.tokens?.output ?? 0;
    cache_read += row.tokens?.cache_read ?? 0;
    reasoning += row.tokens?.reasoning ?? 0;
    cacheWriteInputTokens += row.raw?.cacheWriteInputTokens ?? 0;
  }
  return {
    input,
    output,
    cache_read,
    cache_creation: null,
    cache_read_peak: null,
    reasoning,
    cacheWriteInputTokens,
  };
}

function finalizeCodexTurn(turn) {
  const aggregated = aggregateCodexTokenRows(turn.tokenRows);
  const { cacheWriteInputTokens, reasoning, ...tokens } = aggregated;
  const spawnTypes = [...new Set(turn.spawnAgentTypes)];
  let item = turn.item;
  if (spawnTypes.length > 0) {
    const spawnLabel = `[spawn: ${spawnTypes.join(", ")}]`;
    item = item ? `${item} ${spawnLabel}` : spawnLabel;
  }
  return {
    ts: turn.ts,
    actor: "main",
    item,
    spawn_agent_types: spawnTypes,
    duration_ms: turn.duration_ms ?? null,
    tokens: { ...tokens, reasoning },
    raw: { cacheWriteInputTokens },
    children: [],
  };
}

function createCodexTurn({ turnId, ts }) {
  return {
    turnId,
    ts,
    duration_ms: null,
    item: "",
    spawnAgentTypes: [],
    tokenRows: [],
    completed: false,
  };
}

/**
 * Turn-aware Codex rollout parser. Streams line-by-line without retaining
 * turn_context / bulk response_item payloads. When `task_started` boundaries
 * exist, emits one ledger row per turn (item from user prompt, duration from
 * `task_complete` / `turn_aborted`, actor stays `main` (caller rollout tokens are
 * not child attribution); `spawn_agent` types are labeled on `item` only.
 */
export function parseCodexRollout(content, { includeTurnStates = false } = {}) {
  const openTurns = new Map();
  const finalizedTurnStates = [];
  const fallbackRows = [];
  let activeTurnId = null;
  let pendingUserItemText = null;
  let totalUsage = null;
  let malformedCount = 0;
  let orphanTokenCount = 0;
  let spawnEvents = 0;
  let malformedSpawnCount = 0;
  let lastEventTs = null;
  // T29: spawn dispatch join (call_id -> child agent_path) and same-thread
  // continuation calls; the child's own turn boundaries stay authoritative.
  const pendingSpawnCalls = new Map();
  const spawnDispatches = [];
  let continuationEvents = 0;
  let firstTaskStartedTs = null;
  let usageEventOrdinal = 0;
  const usageEvents = [];
  const legacyRowOrders = new Map();

  const applyUserItemToTurn = (turn, itemText) => {
    if (itemText && !turn.item) turn.item = itemText;
  };

  const captureUserItemText = (itemText) => {
    if (!itemText) return;
    if (activeTurnId) {
      const turn = openTurns.get(activeTurnId);
      if (turn && !turn.completed) applyUserItemToTurn(turn, itemText);
      return;
    }
    pendingUserItemText = itemText;
  };

  const attachTokenRow = (row) => {
    fallbackRows.push(row);
    if (!activeTurnId) {
      orphanTokenCount += 1;
      return;
    }
    const turn = openTurns.get(activeTurnId);
    if (turn && !turn.completed) turn.tokenRows.push(row);
    else orphanTokenCount += 1;
  };

  const closeTurn = (turnId, durationMs) => {
    const turn = openTurns.get(turnId);
    if (!turn || turn.completed) return;
    turn.duration_ms = durationMs ?? turn.duration_ms;
    turn.completed = true;
    finalizedTurnStates.push(turn);
    if (activeTurnId === turnId) activeTurnId = null;
  };

  const text = String(content ?? "");
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const rawEnd = nl === -1 ? text.length : nl;
    const rawLine = text.slice(start, rawEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length > 0) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        malformedCount += 1;
        record = null;
      }
      if (record) {
        if (typeof record.timestamp === "string") lastEventTs = record.timestamp;
        if (isCodexTokenUsageRecord(record)) {
          usageEvents.push(codexTokenUsageRecordToEvidence(record, usageEventOrdinal++));
        } else if (record.type === "event_msg") {
          const payload = record.payload ?? {};
          if (payload.type === "task_started" && payload.turn_id) {
            if (firstTaskStartedTs === null && typeof record.timestamp === "string") firstTaskStartedTs = record.timestamp;
            const turn = createCodexTurn({ turnId: payload.turn_id, ts: record.timestamp ?? null });
            if (pendingUserItemText) {
              applyUserItemToTurn(turn, pendingUserItemText);
              pendingUserItemText = null;
            }
            openTurns.set(payload.turn_id, turn);
            activeTurnId = payload.turn_id;
          } else if (payload.type === "user_message") {
            captureUserItemText(extractCodexUserMessageEventText(payload));
          } else if (
            (payload.type === "task_complete" || payload.type === "turn_aborted") &&
            payload.turn_id
          ) {
            const turn = openTurns.get(payload.turn_id);
            if (turn && !turn.completed) {
              turn.duration_ms = payload.duration_ms ?? turn.duration_ms;
            }
            closeTurn(payload.turn_id, payload.duration_ms ?? null);
          } else if (isCodexTokenCountRecord(record)) {
            totalUsage = record.payload.info.total_token_usage ?? totalUsage;
            const row = codexTokenCountRecordToRow(record);
            const order = usageEventOrdinal++;
            legacyRowOrders.set(row, order);
            attachTokenRow(row);
            usageEvents.push({
              kind: "legacy",
              order,
              ts: record.timestamp ?? null,
              row,
              cumulative: record.payload.info.total_token_usage ?? null,
            });
          }
        } else if (record.type === "response_item") {
          const payload = record.payload ?? {};
          captureUserItemText(extractCodexUserItemText(payload));
          const spawn = extractSpawnAgentType(payload);
          if (spawn.observed) spawnEvents += 1;
          if (spawn.malformed) malformedSpawnCount += 1;
          if (spawn.observed && !spawn.malformed && typeof payload.call_id === "string" && payload.call_id) {
            pendingSpawnCalls.set(payload.call_id, { agent_type: spawn.agentType, fork_turns: spawn.forkTurns, fork_context: spawn.forkContext });
          }
          if (payload.type === "function_call_output" && typeof payload.call_id === "string" && pendingSpawnCalls.has(payload.call_id)) {
            const pending = pendingSpawnCalls.get(payload.call_id);
            pendingSpawnCalls.delete(payload.call_id);
            spawnDispatches.push({ ...pending, agent_path: extractSpawnOutputAgentPath(payload.output) });
          }
          if (payload.type === "function_call" && payload.name === CODEX_CONTINUATION_TOOL) continuationEvents += 1;
          if (activeTurnId) {
            const turn = openTurns.get(activeTurnId);
            if (turn && !turn.completed) {
              if (spawn.agentType) turn.spawnAgentTypes.push(spawn.agentType);
            }
          }
        }
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }

  for (const turn of openTurns.values()) {
    if (!turn.completed && turn.tokenRows.length > 0) {
      finalizedTurnStates.push(turn);
    }
  }
  const finalizedTurns = finalizedTurnStates.map(finalizeCodexTurn);
  const turnStateMetadata = includeTurnStates
    ? {
        turn_states: openTurns,
        finalized_turn_ids: finalizedTurnStates.map((turn) => turn.turnId),
        legacy_row_orders: legacyRowOrders,
      }
    : {};

  // T29: dispatch turns are the `task_started` boundaries of this thread; a
  // rollout without boundaries has no continuation evidence (null, never 0).
  const turnBoundaries = openTurns.size > 0
    ? { dispatch_turns: openTurns.size, start_ts: firstTaskStartedTs, end_ts: lastEventTs }
    : null;
  const spawnDispatchEvidence = {
    spawn_dispatches: spawnDispatches,
    continuation_events: continuationEvents,
    turn_boundaries: turnBoundaries,
  };

  if (finalizedTurns.length > 0) {
    return {
      turns: finalizedTurns,
      totalUsage,
      malformedCount,
      mode: "turn-aware",
      orphanTokenCount,
      spawn_events: spawnEvents,
      open_turn_count: [...openTurns.values()].filter((turn) => !turn.completed).length,
      last_event_ts: lastEventTs,
      spawn_observability: malformedCount === 0 && malformedSpawnCount === 0 ? "complete" : "partial",
      usage_events: usageEvents,
      ...turnStateMetadata,
      ...spawnDispatchEvidence,
    };
  }

  return {
    turns: fallbackRows,
    totalUsage,
    malformedCount,
    mode: "token-event-fallback",
    orphanTokenCount: 0,
    spawn_events: spawnEvents,
    open_turn_count: [...openTurns.values()].filter((turn) => !turn.completed).length,
    last_event_ts: lastEventTs,
    spawn_observability: malformedCount === 0 && malformedSpawnCount === 0 ? "complete" : "partial",
    usage_events: usageEvents,
    ...turnStateMetadata,
    ...spawnDispatchEvidence,
  };
}

function defaultReadPrefix(absPath, maxBytes) {
  const descriptor = openSync(absPath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(descriptor, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function parseCodexSessionMetaPrefix(content, maxBytes) {
  const text = String(content ?? "");
  const newline = text.indexOf("\n");
  if (newline === -1 && Buffer.byteLength(text, "utf8") >= maxBytes) {
    return { error: "lineage-meta-record-cap-hit", bytes: maxBytes };
  }
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  const bytes = Buffer.byteLength(firstLine, "utf8") + (newline === -1 ? 0 : 1);
  if (bytes > maxBytes) return { error: "lineage-meta-record-cap-hit", bytes: maxBytes };
  try {
    const record = JSON.parse(firstLine);
    if (record?.type !== "session_meta" || !record?.payload?.id) return { error: "codex-session-meta-unresolved", bytes };
    return { record, bytes };
  } catch {
    return { error: "codex-session-meta-unresolved", bytes };
  }
}

function codexFolderDate(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  const match = /\/sessions\/(\d{4})\/(\d{2})\/(\d{2})\//u.exec(normalized);
  return match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`) : Number.NaN;
}

/** Bounded prefix-only Codex parent_thread_id index anchored to root ±24h. */
export function enumerateCodexLineageMetadata({
  root,
  rootSessionId,
  listDir = defaultListDir,
  readPrefix = defaultReadPrefix,
  limits: overrides = {},
} = {}) {
  const limits = {
    max_files: 10_000,
    max_meta_record_bytes: 65_536,
    max_total_meta_bytes: 67_108_864,
    ...overrides,
  };
  let files;
  let directoryReadFailures = 0;
  try {
    files = listCodexJsonlFiles(path.join(root, "sessions"), listDir, 4, {
      onNestedReadFailure: () => { directoryReadFailures += 1; },
    });
  } catch {
    return { nodes: [], edges: [], gaps: [{ name: "codex-root-window-unresolved" }], diagnostics: [], spawn_events: 0, spawn_observability: "unavailable" };
  }
  const rootFile = files.find((file) => path.basename(file).includes(rootSessionId));
  if (!rootFile) {
    return { nodes: [], edges: [], gaps: [{ name: "codex-root-window-unresolved" }], diagnostics: [], spawn_events: 0, spawn_observability: "unavailable" };
  }
  const prefixCache = new Map();
  const readMeta = (file) => {
    if (prefixCache.has(file)) return prefixCache.get(file);
    let parsed;
    try {
      parsed = parseCodexSessionMetaPrefix(readPrefix(file, limits.max_meta_record_bytes), limits.max_meta_record_bytes);
    } catch {
      parsed = { error: "codex-session-meta-read-failed", bytes: 0 };
    }
    prefixCache.set(file, parsed);
    return parsed;
  };
  const rootMeta = readMeta(rootFile);
  const rootTs = rootMeta.record?.timestamp;
  if (!rootTs || Number.isNaN(Date.parse(rootTs))) {
    return { nodes: [], edges: [], gaps: [{ name: rootMeta.error ?? "codex-root-window-unresolved" }, { name: "codex-root-window-unresolved" }], diagnostics: [], spawn_events: 0, spawn_observability: "unavailable" };
  }
  const rootMillis = Date.parse(rootTs);
  const lowDay = Date.UTC(new Date(rootMillis - 86_400_000).getUTCFullYear(), new Date(rootMillis - 86_400_000).getUTCMonth(), new Date(rootMillis - 86_400_000).getUTCDate());
  const highDay = Date.UTC(new Date(rootMillis + 86_400_000).getUTCFullYear(), new Date(rootMillis + 86_400_000).getUTCMonth(), new Date(rootMillis + 86_400_000).getUTCDate());
  let candidates = files.filter((file) => {
    const day = codexFolderDate(file);
    return Number.isFinite(day) && day >= lowDay && day <= highDay;
  }).sort((left, right) => right.localeCompare(left));
  if (candidates.includes(rootFile)) candidates = [rootFile, ...candidates.filter((file) => file !== rootFile)];
  const gaps = directoryReadFailures > 0
    ? [{ name: "codex-lineage-directory-read-failed", count: directoryReadFailures }]
    : [];
  if (candidates.length > limits.max_files) {
    candidates = candidates.slice(0, limits.max_files);
    gaps.push({ name: "lineage-file-cap-hit" });
  }
  const nodes = [];
  const edges = [];
  const identityFiles = new Map();
  let totalBytes = 0;
  for (const file of candidates) {
    const meta = readMeta(file);
    totalBytes += meta.bytes ?? 0;
    if (totalBytes > limits.max_total_meta_bytes) {
      gaps.push({ name: "lineage-byte-cap-hit" });
      break;
    }
    if (meta.error) {
      gaps.push({ name: meta.error });
      continue;
    }
    const metadataMillis = Date.parse(meta.record.timestamp);
    if (!Number.isFinite(metadataMillis)) {
      gaps.push({ name: "codex-session-meta-timestamp-unresolved" });
      continue;
    }
    if (metadataMillis < rootMillis - 86_400_000 || metadataMillis > rootMillis + 86_400_000) continue;
    const sessionId = meta.record.payload.id;
    if (identityFiles.has(sessionId) && identityFiles.get(sessionId) !== file) {
      gaps.push({ name: "lineage-identity-collision", identity: `codex:${sessionId}` });
      continue;
    }
    identityFiles.set(sessionId, file);
    const node = {
      host: "codex",
      session_id: sessionId,
      carrier_digest: createHash("sha256").update(meta.record ? JSON.stringify(meta.record) : "").digest("hex"),
      started_at: meta.record.timestamp ?? null,
    };
    // T29: the spawn carrier of a child thread (codex-cli 0.152.1 live
    // fixture): depth, the custom agent name and the join path to the parent's
    // spawn_agent output. Metadata only — no cwd, nickname, or prompt bytes.
    const threadSpawn = meta.record.payload?.source?.subagent?.thread_spawn;
    if (threadSpawn && typeof threadSpawn === "object") {
      const agentRole = typeof threadSpawn.agent_role === "string" ? threadSpawn.agent_role : meta.record.payload?.agent_role;
      node.spawn_carrier = {
        agent_role: typeof agentRole === "string" && agentRole ? agentRole : null,
        agent_path: typeof threadSpawn.agent_path === "string" && threadSpawn.agent_path ? threadSpawn.agent_path : null,
        depth: Number.isInteger(threadSpawn.depth) ? threadSpawn.depth : null,
      };
    }
    nodes.push(node);
    const parentId = threadSpawn?.parent_thread_id;
    if (typeof parentId === "string" && parentId) {
      edges.push({
        parent_identity: `codex:${parentId}`,
        child_identity: `codex:${sessionId}`,
        evidence_digest: createHash("sha256").update(`${parentId}:${sessionId}`).digest("hex"),
      });
    }
  }
  return {
    nodes,
    edges,
    gaps,
    diagnostics: [],
    spawn_events: edges.length,
    spawn_observability: gaps.length === 0 ? "complete" : "partial",
  };
}

/** F-C1: walk the real nested `sessions/<YYYY>/<MM>/<DD>/*.jsonl` layout
 * (three levels of date subdirectories), not a flat `sessions/*.jsonl` dir.
 * `maxDepth` bounds recursion defensively past the observed 3-level layout. */
function listCodexJsonlFiles(sessionsDir, listDir, maxDepth = 4, { onNestedReadFailure } = {}) {
  const files = [];
  const walk = (dir, depth) => {
    const entries = listDir(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry.endsWith(".jsonl")) {
        files.push(full);
      } else if (depth < maxDepth) {
        try {
          walk(full, depth + 1);
        } catch {
          // Discovery may ignore non-directories, but lineage callers record
          // the ambiguity so an unreadable subtree cannot look complete.
          onNestedReadFailure?.(full);
        }
      }
    }
  };
  walk(sessionsDir, 0); // let a missing sessionsDir throw to the caller.
  return files;
}

function discoverCodexSessionFile({ root, sessionId, latest, cwdRoots, listDir, readFile, realpath }) {
  const sessionsDir = path.join(root, "sessions");
  let files;
  try {
    files = listCodexJsonlFiles(sessionsDir, listDir);
  } catch {
    return { error: "host root not found" };
  }

  if (sessionId) {
    const match = files.find((f) => path.basename(f).includes(sessionId));
    if (!match) return { error: "session not found" };
    return { file: match, sessionId, source: "exact" };
  }

  if (latest) {
    const candidates = [];
    for (const filePath of files) {
      let content;
      try {
        content = readFile(filePath);
      } catch {
        continue;
      }
      // F-C1c: probe only (session_meta is verified to always be the first
      // record of a real rollout file) — never retain `content`, and never
      // fully `parseJsonl` every candidate, just to read one field. Real
      // rollout files observed on this machine range up to 1.4GB across
      // 2665 files; F-I6 widened cwdRoots to every worktree of this repo, so
      // retaining every matching candidate's full content is what exhausted
      // the heap. `firstCwd` fallback is dropped: real Codex records have no
      // top-level `cwd` field, so that fallback was already inert. The
      // winner is re-read and fully parsed once below.
      const meta = scanLeadingRecords(content, 10, (record) => (record?.type === "session_meta" ? record.payload : null));
      const cwd = meta?.cwd ?? null;
      if (!matchesCwdRoots(cwd, cwdRoots, realpath)) continue;
      const lastRecord = lastParseableJsonLine(content);
      candidates.push({ filePath, lastTs: lastRecord?.timestamp ?? "", sessionId: meta?.id ?? null });
    }
    if (candidates.length === 0) return { error: "no session found" };
    candidates.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
    const picked = candidates[0];
    return { file: picked.filePath, sessionId: picked.sessionId, source: "latest-fallback" };
  }

  return { error: "no session specified" };
}

/**
 * @param {object} options
 * @param {string} options.root - injected `CODEX_HOME`-equivalent root
 * @param {string} [options.sessionId] - explicit `--session`
 * @param {object} [options.env] - injected env (for `CODEX_SESSION_ID`)
 * @param {boolean} [options.latest]
 * @param {string[]} [options.cwdRoots]
 * @param {(p:string)=>string} [options.readFile]
 * @param {(p:string)=>string[]} [options.listDir]
 * @param {(p:string)=>string} [options.realpath]
 */
export function readCodexSession({
  root,
  sessionId,
  env,
  latest,
  cwdRoots = [],
  readFile = defaultReadFile,
  listDir = defaultListDir,
  realpath = defaultRealpath,
  fileSize = defaultFileSize,
} = {}) {
  const rootCheck = ensureHostRoot({ root, listDir });
  if (!rootCheck.available) return rootCheck;

  let resolvedSessionId;
  if (sessionId !== undefined && sessionId !== null && sessionId !== "") {
    if (!isValidSessionIdShape(sessionId)) {
      return { available: false, reason: "invalid session id shape" };
    }
    resolvedSessionId = sessionId;
  } else if (env && Object.hasOwn(env, "CODEX_SESSION_ID") && env.CODEX_SESSION_ID) {
    // F-S1: reuse the single resolveCodexSessionId(env) implementation
    // instead of re-deriving the same UUID-shape check inline. A present but
    // malformed CODEX_SESSION_ID still MUST fail closed with a named reason
    // (not silently fall through to --latest) rather than resolving to null
    // and being treated as "not set".
    const resolved = resolveCodexSessionId(env);
    if (!resolved) {
      return { available: false, reason: "invalid session id shape" };
    }
    resolvedSessionId = resolved;
  }

  const discovery = discoverCodexSessionFile({ root, sessionId: resolvedSessionId, latest, cwdRoots, listDir, readFile, realpath });
  if (discovery.error) return { available: false, reason: discovery.error };

  const transcript = readTranscript(discovery.file, { readFile, fileSize, preloadedContent: discovery.preloadedContent });
  if (transcript.error) return { available: false, reason: transcript.error };
  const content = transcript.content;
  const {
    turns: parsedTurns,
    totalUsage,
    malformedCount,
    mode,
    orphanTokenCount,
    spawn_events,
    open_turn_count,
    last_event_ts,
    spawn_observability,
    spawn_dispatches,
    continuation_events,
    turn_boundaries,
    usage_events,
    turn_states: turnStates = new Map(),
    finalized_turn_ids: finalizedTurnIds = [],
    legacy_row_orders: legacyRowOrders = new Map(),
  } = parseCodexRollout(content, { includeTurnStates: true });

  const legacyEventRows = (usage_events ?? []).filter((event) => event.kind === "legacy").map((event) => event.row);
  const legacyTotals = {
    input: totalsFrom(legacyEventRows, "input"),
    output: totalsFrom(legacyEventRows, "output"),
    cache_read: totalsFrom(legacyEventRows, "cache_read"),
    cache_creation: null,
  };
  const usageAccounting = buildCodexUsageAccounting({
    usageEvents: usage_events ?? [],
    rootThreadId: discovery.sessionId ?? resolvedSessionId ?? null,
    legacyTotals,
  });

  const selectedSegment = usageAccounting.selected_root_segment;
  if (selectedSegment) {
    for (const turn of turnStates.values()) {
      turn.tokenRows = turn.tokenRows.filter((row) => {
        const order = legacyRowOrders.get(row);
        return selectedSegment.source === "legacy-token-count" && Number.isInteger(order) &&
          order >= selectedSegment.first_ordinal && order <= selectedSegment.last_ordinal;
      });
    }
    if (selectedSegment.source === "token-usage-record") {
      for (const evidence of usageAccounting.root_record_rows) {
        const turn = evidence.turnId ? turnStates.get(evidence.turnId) : null;
        if (turn) turn.tokenRows.push(evidence.row);
      }
    }
  }

  const unassignedRecordRows = usageAccounting.root_record_rows
    .filter((evidence) => !evidence.turnId || !turnStates.has(evidence.turnId))
    .map((evidence) => ({
      ts: evidence.row.ts,
      tokens: { ...evidence.row.tokens },
      source: "token-usage-record",
    }));
  const assignedLegacyRows = new Set([...turnStates.values()].flatMap((turn) => turn.tokenRows));
  const unassignedLegacyEvents = selectedSegment?.source === "legacy-token-count" &&
      (mode === "turn-aware" || mode === "token-event-fallback")
    ? (usage_events ?? [])
      .filter((event) => event.kind === "legacy" && event.order >= selectedSegment.first_ordinal && event.order <= selectedSegment.last_ordinal)
      .filter((event) => mode === "token-event-fallback" || !assignedLegacyRows.has(event.row))
    : [];
  const unassignedLegacyRows = unassignedLegacyEvents.map((event) => ({
        ts: event.ts,
        tokens: { ...event.row.tokens },
        source: "legacy-token-count",
      }));
  const unassignedLegacyTurnRows = new Set(unassignedLegacyEvents.map((event) => event.row));
  const unassignedRows = [...unassignedRecordRows, ...unassignedLegacyRows].sort((left, right) => String(left.ts ?? "").localeCompare(String(right.ts ?? "")));
  const unknownThreadEvents = (usageAccounting.unknown_thread_events ?? []).map((event) => ({ ts: event.ts }));
  const unknownThreadRows = (usageAccounting.unknown_thread_events ?? []).map((event) => ({
    ts: event.ts,
    tokens: { ...event.tokens },
    source: "token-usage-record-unresolved-thread",
  }));
  const unknownThreadTotals = {
    input: diagnosticTotalsFrom(unknownThreadRows, "input"),
    output: diagnosticTotalsFrom(unknownThreadRows, "output"),
    cache_read: diagnosticTotalsFrom(unknownThreadRows, "cache_read"),
    cache_creation: null,
  };
  const unknownResponseEvents = (usageAccounting.unknown_response_events ?? []).map((event) => ({ ts: event.ts }));
  const unknownResponseRows = (usageAccounting.unknown_response_events ?? []).map((event) => ({
    ts: event.ts,
    tokens: { ...event.tokens },
    source: "token-usage-record-unresolved-response",
  }));
  const unknownResponseTotals = {
    input: diagnosticTotalsFrom(unknownResponseRows, "input"),
    output: diagnosticTotalsFrom(unknownResponseRows, "output"),
    cache_read: diagnosticTotalsFrom(unknownResponseRows, "cache_read"),
    cache_creation: null,
  };
  const unassignedUsage = {
    rows: unassignedRows,
    unknown_thread_events: unknownThreadEvents,
    unknown_thread_rows: unknownThreadRows,
    unknown_thread_totals: unknownThreadTotals,
    unknown_response_events: unknownResponseEvents,
    unknown_response_rows: unknownResponseRows,
    unknown_response_totals: unknownResponseTotals,
  };
  const rows = mode === "turn-aware"
    ? (() => {
        const includedTurnIds = [...finalizedTurnIds];
        for (const turn of turnStates.values()) {
          if (!turn.completed && turn.tokenRows.length > 0 && !includedTurnIds.includes(turn.turnId)) includedTurnIds.push(turn.turnId);
        }
        return includedTurnIds.map((turnId) => finalizeCodexTurn(turnStates.get(turnId)));
      })()
    : selectedSegment
      ? parsedTurns.filter((row) => {
          const order = legacyRowOrders.get(row);
          return selectedSegment.source === "legacy-token-count" && Number.isInteger(order) &&
            order >= selectedSegment.first_ordinal && order <= selectedSegment.last_ordinal;
        })
      : parsedTurns;
  const totals = usageAccounting.totals ?? legacyTotals;

  const gaps = [...usageAccounting.gaps];
  const outsideTurnCount = orphanTokenCount + unassignedRecordRows.length +
    (mode === "token-event-fallback" ? unassignedLegacyEvents.length : 0);
  if (outsideTurnCount > 0) {
    gaps.push({ name: "codex-token-outside-turn", count: outsideTurnCount });
  }
  let cacheReadAvailability = "available";
  let hostTotals = usageAccounting.hostTotals;
  const useRecordAccounting = usageAccounting.has_root_record_events || usageAccounting.mixed;
  if (useRecordAccounting) {
    cacheReadAvailability = usageAccounting.usage_reconciliation?.status === "reconciled"
      ? "available"
      : "unverified-on-host";
  } else if (totalUsage) {
    hostTotals = {
      input: (totalUsage.input_tokens ?? 0) - (totalUsage.cached_input_tokens ?? 0),
      output: totalUsage.output_tokens ?? 0,
      cache_read: totalUsage.cached_input_tokens ?? 0,
      cache_creation: null,
    };
    const reconciliation = reconcileCacheRead({
      ledgerTotal: totals.cache_read,
      hostTotal: totalUsage.cached_input_tokens ?? 0,
      hasHostSource: true,
    });
    cacheReadAvailability = reconciliation.fieldAvailability;
    if (reconciliation.gap) gaps.push(reconciliation.gap);

    const hostOutput = totalUsage.output_tokens ?? 0;
    if (totals.output !== hostOutput) {
      gaps.push({ name: "output-mismatch", ledger_total: totals.output, host_total: hostOutput, delta: totals.output - hostOutput });
    }

    // F-I4: `input` was silently dropped from reconciliation — only
    // output/cache_read were checked. `input` DOES have an authoritative
    // host total (`total_token_usage.input_tokens - cached_input_tokens`),
    // so a mismatch MUST be named, not picked one way silently (design.md T5(ii)).
    const hostInput = (totalUsage.input_tokens ?? 0) - (totalUsage.cached_input_tokens ?? 0);
    if (totals.input !== hostInput) {
      gaps.push({ name: "input-mismatch", ledger_total: totals.input, host_total: hostInput, delta: totals.input - hostInput });
    }
  } else {
    gaps.push({ name: "no-total-token-usage" });
    // F-PR-CODEX-NO-TOTAL: without cumulative total_token_usage, cache_read
    // has no authoritative host total to reconcile — MUST NOT stay "available".
    cacheReadAvailability = "unverified-on-host";
  }

  // `cache_creation` has no authoritative host total to reconcile against
  // (`total_token_usage` carries no `cache_write_input_tokens` field at all —
  // only per-event `last_token_usage` does), so there is nothing to diff.
  // The existing fail-closed check below already names any nonzero
  // cache_write_input_tokens as a gap instead of silently picking a side.
  if (rows.some((r) => (r.raw?.cacheWriteInputTokens ?? 0) !== 0)) {
    gaps.push({ name: "cache-write-input-tokens-nonzero" });
  }

  // F-C4: a malformed trailing line degrades (named gap), never crashes.
  if (malformedCount > 0) gaps.push({ name: "malformed-jsonl-line", count: malformedCount });

  const gapEffects = gaps
    .filter((gap) => gap.thread_attribution !== "foreign")
    .map((gap) => classifySessionUsageGap(gap, { domain: "codex-metering" }));
  const unverifiedMetrics = new Set(gapEffects
    .filter((effect) => effect.reconciliation !== "preserve")
    .flatMap((effect) => effect.affected_metrics));
  const gapBlocksReconciliation = gapEffects.some((effect) => effect.reconciliation !== "preserve");
  const usageReconciliation = gapBlocksReconciliation
    ? { status: "unverified" }
    : usageAccounting.usage_reconciliation ?? { status: totalUsage ? "reconciled" : "unverified" };
  const recordMetricAvailability = usageReconciliation.status === "reconciled" ? "available" : "unverified-on-host";
  const metricAvailability = (metric, fallback) => {
    if (metric === "cache_read" && fallback === "unreconciled") return fallback;
    return unverifiedMetrics.has(metric) ? "unverified-on-host" : fallback;
  };

  return {
    available: true,
    session: discovery.sessionId ?? resolvedSessionId ?? null,
    source: discovery.source,
    cost_usd: null,
    turns: rows.map((r) => ({
      ts: r.ts,
      actor: r.actor,
      item: r.item,
      duration_ms: r.duration_ms,
      tokens: r.tokens,
      ...(unassignedLegacyTurnRows.has(r) ? { attribution: "unassigned" } : {}),
      children: [],
    })),
    totals,
    hostTotals,
    gaps,
    usage_source: usageAccounting.usage_source,
    usage_segments: usageAccounting.usage_segments,
    usage_reconciliation: usageReconciliation,
    usage_attribution: {
      status: unassignedRows.length === 0 && unknownThreadEvents.length === 0 && unknownResponseEvents.length === 0 && orphanTokenCount === 0 ? "verified" : "unverified",
      unassigned_response_count: unassignedRows.length,
      unknown_thread_event_count: unknownThreadEvents.length,
      unknown_response_event_count: unknownResponseEvents.length,
    },
    unassigned_usage: unassignedUsage,
    spawn_events,
    open_turn_count,
    last_event_ts,
    spawn_observability,
    spawn_dispatches,
    continuation_events,
    turn_boundaries,
    terminality: open_turn_count > 0 ? "open" : "unknown",
    field_availability: {
      input: metricAvailability("input", useRecordAccounting ? recordMetricAvailability : "derived"),
      output: metricAvailability("output", useRecordAccounting ? recordMetricAvailability : "available"),
      cache_creation: "unverified-on-host",
      cost_usd: "unsupported-by-host",
      cache_read: metricAvailability("cache_read", useRecordAccounting ? recordMetricAvailability : cacheReadAvailability),
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher (D10)
// ---------------------------------------------------------------------------

export function collectSessionUsage({ host = "auto", ...rest } = {}) {
  if (host === "claude-code") return { host: "claude-code", ...readClaudeCodeSession(rest) };
  if (host === "codex") return { host: "codex", ...readCodexSession(rest) };
  if (host === "auto") {
    const claudeCode = { host: "claude-code", ...readClaudeCodeSession(rest) };
    const codex = { host: "codex", ...readCodexSession(rest) };
    const available = [claudeCode, codex].filter((r) => r.available);
    return { host: "auto", results: available.length > 0 ? available : [claudeCode, codex] };
  }
  throw new Error(`unknown host: ${host}`);
}

// ---------------------------------------------------------------------------
// `--since-change` aggregation (design.md D7 — round 4 finding F-4-1, round 5
// findings F-5-1/F-5-2, round 6 finding F-6-2)
// ---------------------------------------------------------------------------

/**
 * Aggregate token usage for a named change from its D7 checkpoint
 * `sessions[]` entries. Per entry:
 *  - F-5-2: dispatch to the resolver named by the entry's OWN `host` field
 *    via the injected `collectSessionUsage` — no guessing, no trying the
 *    other host as a fallback. A `host` outside `{claude-code, codex}`
 *    (should never happen on a well-formed write path) degrades this entry
 *    to `unavailable` the same way a resolver failure does.
 *  - F-5-1: on a successful resolve, filter that session's `turns` to
 *    `turn.ts >= entry.start_ts` BEFORE calling `totalsFrom` — never read the
 *    session-wide unfiltered `totals` the reader also returns.
 *  - F-6-2: additionally bound above by the next differing-or-not session
 *    transition record for this `session_id` in the global ledger (found via
 *    the injected `getSessionTransitions`), so turns after this session left
 *    this change for another named change are excluded. A ledger read
 *    failure (`status !== "ok"`) degrades this entry to `unavailable`
 *    (same downgrade path as an unresolved session — not a new failure
 *    mode). No matching "own" transition record, or no NEXT record after it,
 *    leaves this entry unbounded above (current/legacy behavior).
 *  - Any entry that ends up `unavailable` is named in `sessions[]` output,
 *    never silently skipped and never counted as 0 (F-4-1).
 *
 * `coverage` is `"complete"` only when every `sessions[]` entry resolved;
 * otherwise `"partial"`.
 *
 * @param {object} options
 * @param {Array<{session_id:string, start_ts:string, host:string}>} options.sessions
 * @param {string} options.changeName
 * @param {(args:object)=>object} options.collectSessionUsage - injected dispatcher (F-S1 precedent: caller controls host/root wiring, this function never re-derives it)
 * @param {{claudeRoot:string, codexRoot:string}} options.roots
 * @param {object} [options.env]
 * @param {(sessionId:string)=>{status:string, records?:Array<{session_id:string, change_name:string, at:string}>}} options.getSessionTransitions
 */
/**
 * Resolves this function's own `roots` parameter shape from env vars, with
 * homeDir-relative defaults. Exported (D2-style: a previously CLI-internal
 * helper made available to a second caller, not duplicated) so
 * `resolve-change-cost-usage.mjs` (task 6/7's shared change-name -> usage
 * resolver) can build the same `{claudeRoot, codexRoot}` shape this function
 * requires, without report-session-token-usage.mjs's CLI file becoming a lib
 * dependency of another lib.
 */
export function resolveRoots(env, homeDir) {
  return {
    claudeRoot: env.DEVPRO_TEST_CLAUDE_ROOT ?? env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, ".claude"),
    codexRoot: env.DEVPRO_TEST_CODEX_ROOT ?? env.CODEX_HOME ?? path.join(homeDir, ".codex"),
  };
}

/**
 * Read-time union of checkpoint `sessions[]` with `overrides[]` continuation
 * session_ids (R6). Override events are measurement roots, not pre-summed
 * totals — callers still run `collectSessionUsage` per session.
 */
export function unionCheckpointMeasurementSessions(checkpoint) {
  const sessions = Array.isArray(checkpoint?.sessions) ? checkpoint.sessions : [];
  const overrides = Array.isArray(checkpoint?.overrides) ? checkpoint.overrides : [];
  const byId = new Map();
  for (const entry of sessions) {
    if (!entry?.session_id) continue;
    byId.set(entry.session_id, {
      ...entry,
      source: entry.source ?? "session",
    });
  }
  for (const override of overrides) {
    if (!override?.session_id || byId.has(override.session_id)) continue;
    byId.set(override.session_id, {
      session_id: override.session_id,
      host: override.host ?? null,
      start_ts: typeof override.at === "string" && override.at
        ? override.at
        : "1970-01-01T00:00:00.000Z",
      source: "override",
    });
  }
  return [...byId.values()];
}

export function aggregateSinceChangeUsage({
  sessions,
  changeName,
  collectSessionUsage,
  roots,
  env,
  getSessionTransitions,
}) {
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, model_time_ms: 0 };
  const detail = [];
  let allResolved = true;
  let attributionVerified = true;

  for (const entry of sessions ?? []) {
    let { session_id, start_ts, host } = entry;
    const source = entry.source ?? "session";

    if (!host) {
      // Override-only rows may omit host; probe both roots before naming a gap.
      let resolvedHost = null;
      for (const candidate of ["claude-code", "codex"]) {
        const root = candidate === "claude-code" ? roots.claudeRoot : roots.codexRoot;
        const probe = collectSessionUsage({ host: candidate, root, sessionId: session_id, env });
        if (probe.available) {
          resolvedHost = candidate;
          break;
        }
      }
      if (!resolvedHost) {
        const neutralIdentity = isValidNeutralSessionIdShape(session_id) && !isValidSessionIdShape(session_id);
        allResolved = false;
        detail.push({
          session_id,
          host: neutralIdentity ? "host-neutral" : null,
          start_ts,
          status: "unavailable",
          reason: neutralIdentity ? "host-neutral-no-telemetry" : "override session host unresolved",
          source,
        });
        continue;
      }
      host = resolvedHost;
    }

    if (host === "host-neutral") {
      // Provider-neutral host: the identity is valid but telemetry is
      // structurally absent (no transcript store). Named degrade, not the
      // invalid-host corruption signal (strengthen-host-session-neutrality
      // F-hsn-r1-03).
      allResolved = false;
      detail.push({
        session_id,
        host,
        start_ts,
        status: "unavailable",
        reason: "host-neutral-no-telemetry",
        source,
      });
      continue;
    }

    if (host !== "claude-code" && host !== "codex") {
      allResolved = false;
      detail.push({ session_id, host, start_ts, status: "unavailable", reason: `invalid host: ${host}`, source });
      continue;
    }

    const root = host === "claude-code" ? roots.claudeRoot : roots.codexRoot;
    const usage = collectSessionUsage({ host, root, sessionId: session_id, env });
    if (!usage.available) {
      allResolved = false;
      detail.push({ session_id, host, start_ts, status: "unavailable", reason: usage.reason, source });
      continue;
    }

    const transitions = getSessionTransitions(session_id);
    if (transitions.status !== "ok") {
      allResolved = false;
      detail.push({
        session_id,
        host,
        start_ts,
        status: "unavailable",
        reason: "session-transitions ledger unavailable",
        source,
      });
      continue;
    }

    const records = transitions.records ?? [];
    const next = records.find((r) => r.at > start_ts);
    const upperBoundAt = next ? next.at : null;

    const filteredTurns = (usage.turns ?? []).filter((turn) => {
      if (typeof turn.ts !== "string" || turn.ts < start_ts) return false;
      if (upperBoundAt !== null && !(turn.ts < upperBoundAt)) return false;
      return true;
    });
    const isWithinChangeWindow = (row) => {
      if (typeof row?.ts !== "string") return true;
      if (row.ts < start_ts) return false;
      if (upperBoundAt !== null && !(row.ts < upperBoundAt)) return false;
      return true;
    };
    const unassignedUsageRows = (usage.unassigned_usage?.rows ?? []).filter(isWithinChangeWindow);
    const unknownThreadEvents = (usage.unassigned_usage?.unknown_thread_events ?? []).filter(isWithinChangeWindow);
    const unknownThreadRows = (usage.unassigned_usage?.unknown_thread_rows ?? []).filter(isWithinChangeWindow);
    const unknownThreadTotals = {
      input: diagnosticTotalsFrom(unknownThreadRows, "input"),
      output: diagnosticTotalsFrom(unknownThreadRows, "output"),
      cache_read: diagnosticTotalsFrom(unknownThreadRows, "cache_read"),
      cache_creation: null,
    };
    const unknownResponseEvents = (usage.unassigned_usage?.unknown_response_events ?? []).filter(isWithinChangeWindow);
    const unknownResponseRows = (usage.unassigned_usage?.unknown_response_rows ?? []).filter(isWithinChangeWindow);
    const unknownResponseTotals = {
      input: diagnosticTotalsFrom(unknownResponseRows, "input"),
      output: diagnosticTotalsFrom(unknownResponseRows, "output"),
      cache_read: diagnosticTotalsFrom(unknownResponseRows, "cache_read"),
      cache_creation: null,
    };
    const sessionAttributionVerified = unassignedUsageRows.length === 0 && unknownThreadEvents.length === 0 && unknownResponseEvents.length === 0;
    if (!sessionAttributionVerified) attributionVerified = false;
    const scopedGaps = (usage.gaps ?? []).filter((gap) => ![
      "codex-token-outside-turn",
      "codex-thread-identity-unresolved",
    ].includes(gap.name));
    if (unassignedUsageRows.length > 0) scopedGaps.push({ name: "codex-token-outside-turn", count: unassignedUsageRows.length });
    if (unknownThreadEvents.length > 0) scopedGaps.push({ name: "codex-thread-identity-unresolved", count: unknownThreadEvents.length });
    const attributedTurns = filteredTurns.filter((turn) => turn.attribution !== "unassigned");
    const rows = [...flattenRows(attributedTurns), ...unassignedUsageRows];
    // Preserve the host's capability state after time-filtering rows. In
    // particular, Codex does not expose cache_creation, so an empty set of
    // supported rows must not become a measured numeric zero.
    const cacheCreationAvailable = usage.field_availability?.cache_creation === "available" ||
      (usage.field_availability?.cache_creation == null && host !== "codex");
    const sessionTotals = {
      input: totalsFrom(rows, "input"),
      output: totalsFrom(rows, "output"),
      cache_read: totalsFrom(rows, "cache_read"),
      cache_creation: cacheCreationAvailable ? totalsFrom(rows, "cache_creation") : null,
    };
    totals.input += sessionTotals.input;
    totals.output += sessionTotals.output;
    totals.cache_read += sessionTotals.cache_read;
    if (sessionTotals.cache_creation === null) totals.cache_creation = null;
    else if (totals.cache_creation !== null) totals.cache_creation += sessionTotals.cache_creation;

    // D6 model-time = sum(per-turn duration_ms), summed over TOP-LEVEL
    // `filteredTurns` only, deliberately NOT over flattened `rows`. A parent
    // turn's own `duration_ms` is a ts-to-ts span from the turn's start to
    // its own last assistant message (parseClaudeCodeTurns), which already
    // encloses any dispatched subagent child's entire execution window
    // whenever the parent resumes after the child returns (the common
    // case — a tool_result does not open a new turn). Additionally summing
    // each child's own `duration_ms` on top would double-count that overlap
    // — an overcount, which is the dangerous direction D6 names explicitly
    // (false positives train operators toward reflexive override, which
    // defeats all four thresholds). Token sums correctly stay on flattened
    // `rows` above: each child's tokens are its own separate spend, not a
    // subset of the parent's.
    let sessionModelTimeMs = 0;
    let durationMissingTurnCount = 0;
    for (const turn of filteredTurns) {
      if (turn.duration_ms == null) {
        durationMissingTurnCount += 1;
      } else {
        sessionModelTimeMs += turn.duration_ms;
      }
    }
    totals.model_time_ms += sessionModelTimeMs;

    detail.push({
      session_id,
      host,
      start_ts,
      status: "ok",
      totals: sessionTotals,
      model_time_ms: sessionModelTimeMs,
      duration_missing_turn_count: durationMissingTurnCount,
      bounded_by: upperBoundAt,
      source,
      usage_source: usage.usage_source ?? null,
      usage_segment_scope: "session-wide",
      usage_segments: usage.usage_segments ?? [],
      usage_reconciliation: usage.usage_reconciliation ?? { status: "unverified" },
      usage_reconciliation_scope: "session-wide",
      field_availability: usage.field_availability ?? {},
      usage_attribution: {
        status: sessionAttributionVerified ? "verified" : "unverified",
        unassigned_response_count: unassignedUsageRows.length,
        unknown_thread_event_count: unknownThreadEvents.length,
        unknown_response_event_count: unknownResponseEvents.length,
      },
      usage_attribution_scope: "current-change",
      unassigned_usage: {
        rows: unassignedUsageRows,
        unknown_thread_events: unknownThreadEvents,
        unknown_thread_rows: unknownThreadRows,
        unknown_thread_totals: unknownThreadTotals,
        unknown_response_events: unknownResponseEvents,
        unknown_response_rows: unknownResponseRows,
        unknown_response_totals: unknownResponseTotals,
      },
      attribution_verified: sessionAttributionVerified,
      gaps: scopedGaps,
    });
  }

  return {
    coverage: allResolved ? "complete" : "partial",
    attribution_verified: allResolved && attributionVerified,
    totals,
    sessions: detail,
  };
}

// ---------------------------------------------------------------------------
// renderMarkdownLedger (T7)
// ---------------------------------------------------------------------------

export const TABLE_HEADER = "| 起 | 耗時 | 誰 | 項目 | input | output | cache_read | cache_creation |";
const TABLE_DELIMITER = "| --- | --- | --- | --- | --- | --- | --- | --- |";
const SORT_FIELDS = new Set(["output", "cache_read", "cache_creation", "duration"]);

/**
 * en-US thousands separators for markdown / Recap display.
 * @param {number} value
 * @param {{ maximumFractionDigits?: number, minimumFractionDigits?: number }} [options]
 */
export function formatDisplayNumber(value, { maximumFractionDigits = 0, minimumFractionDigits } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return num.toLocaleString("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: minimumFractionDigits ?? 0,
  });
}

/** Applies sanitizeItem to every row's `item` at output-assembly time (D7: markdown AND --json). */
export function sanitizeResultItems(result, { homeDir, itemWidth = 80 } = {}) {
  if (!result?.available) return result;
  const turns = (result.turns ?? []).map((t) => ({
    ...t,
    item: sanitizeItem(t.item, { homeDir, itemWidth }),
    children: (t.children ?? []).map((c) => ({ ...c, item: sanitizeItem(c.item, { homeDir, itemWidth }) })),
  }));
  return { ...result, turns };
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${formatDisplayNumber(ms)}ms`;
  const seconds = ms / 1000;
  return `${formatDisplayNumber(seconds, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}s`;
}

function formatCell(value, unavailableReason) {
  if (value === null || value === undefined) {
    return unavailableReason ? `N/A: ${unavailableReason}` : "—";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatDisplayNumber(value);
  }
  return String(value);
}

function sortValue(row, sortKey) {
  if (sortKey === "duration") return row.duration_ms ?? 0;
  return row.tokens?.[sortKey] ?? 0;
}

/**
 * F-I2: `cost_usd === null` reason text MUST be host-aware. Codex genuinely
 * has no USD data source; Claude Code DOES support `totalCostUSD` — a null
 * value there means THIS session had zero cost-state records (the T2a
 * `no-cost-state` gap), not that the host lacks the capability.
 */
function costUsdReasonFor(result) {
  if (result.host === "codex") return "host 未提供 USD";
  return "本 session 無 cost-state 記錄（見 gaps 的 no-cost-state 項）";
}

function formatCostUsdValue(result) {
  if (result.cost_usd === null) return `N/A: ${costUsdReasonFor(result)}`;
  if (result.cost_usd === undefined) return "N/A: 未提供";
  return `$${formatDisplayNumber(result.cost_usd, { maximumFractionDigits: 4 })}`;
}

function totalsAreUnreconciled(gaps) {
  return (gaps ?? []).some(
    (g) =>
      g.name === "cache-read-unreconciled" ||
      g.name === "input-mismatch" ||
      g.name === "output-mismatch",
  );
}

function formatTotalsFieldValue(totals, { hostTotals, gaps } = {}) {
  const display = totalsAreUnreconciled(gaps) && hostTotals ? hostTotals : totals;
  const suffix = totalsAreUnreconciled(gaps) && hostTotals ? " (host authority; ledger unreconciled — see gaps)" : "";
  return `input ${formatCell(display.input)} / output ${formatCell(display.output)} / cache_read ${formatCell(display.cache_read)} / cache_creation ${formatCell(display.cache_creation)}${suffix}`;
}

function formatGapsFieldValue(gaps) {
  if (!gaps || gaps.length === 0) return "無";
  return gaps.map((g) => g.name).join(", ");
}

function formatUsageSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return "not-reported";
  const maxShown = 6;
  const shown = segments.length <= maxShown ? segments : segments.slice(-maxShown);
  const formatted = shown.map((segment) => {
    const source = segment.source ?? "unknown-source";
    const attribution = segment.thread_attribution ?? "unknown-thread";
    const index = Number.isInteger(segment.segment_index) ? `#${segment.segment_index}` : "";
    const totals = segment.totals ?? {};
    const reconciliation = segment.reconciliation ?? "not-reported";
    const timeRange = segment.first_ts || segment.last_ts ? ` ${segment.first_ts ?? "?"}..${segment.last_ts ?? "?"}` : "";
    return `${source}/${attribution}${index}:${reconciliation}(input=${formatCell(totals.input)},output=${formatCell(totals.output)},cache_read=${formatCell(totals.cache_read)})${timeRange}`;
  });
  const omitted = segments.length - shown.length;
  return `${formatted.join("; ")}${omitted > 0 ? `; +${omitted} earlier segment(s) omitted; see --json` : ""}`;
}

function formatUsageAttribution(result) {
  const attribution = result.usage_attribution;
  if (!attribution) return "not-reported";
  const unassigned = attribution.unassigned_response_count ?? result.unassigned_usage?.rows?.length ?? 0;
  const unknownThreads = attribution.unknown_thread_event_count ?? result.unassigned_usage?.unknown_thread_events?.length ?? 0;
  const unknownResponses = attribution.unknown_response_event_count ?? result.unassigned_usage?.unknown_response_events?.length ?? 0;
  const unknownTotals = result.unassigned_usage?.unknown_thread_totals;
  const unknownUsage = unknownThreads > 0 && unknownTotals
    ? `; unknown_thread_usage(input=${formatCell(unknownTotals.input)},output=${formatCell(unknownTotals.output)},cache_read=${formatCell(unknownTotals.cache_read)})`
    : "";
  const unknownResponseTotals = result.unassigned_usage?.unknown_response_totals;
  const unknownResponseUsage = unknownResponses > 0 && unknownResponseTotals
    ? `; unknown_response_usage(input=${formatCell(unknownResponseTotals.input)},output=${formatCell(unknownResponseTotals.output)},cache_read=${formatCell(unknownResponseTotals.cache_read)})`
    : "";
  return `${attribution.status ?? "unknown"}; unassigned_responses=${unassigned}; unknown_thread_events=${unknownThreads}; unknown_response_events=${unknownResponses}${unknownUsage}${unknownResponseUsage}`;
}

/**
 * D9 / task 15: human-readable rendering of groupTurnsByClass's output for
 * `--by-class` CLI text mode. Sorted by turn count, descending, so the
 * dominant class (usually `user` or `stop-hook`) reads first.
 */
export function renderByClassSummary(grouped) {
  const lines = ["by-class:"];
  const classes = Object.keys(grouped).sort((a, b) => grouped[b].count - grouped[a].count);
  for (const cls of classes) {
    const g = grouped[cls];
    lines.push(
      `  ${cls}: turns=${g.count} input=${formatCell(g.tokens.input)} output=${formatCell(g.tokens.output)} ` +
        `cache_read=${formatCell(g.tokens.cache_read)} cache_creation=${formatCell(g.tokens.cache_creation)}`,
    );
  }
  return lines.join("\n");
}

/**
 * @param {object} result - one host's readClaudeCodeSession/readCodexSession() output
 * @param {object} [options]
 * @param {number} [options.top]
 * @param {string} [options.sort]
 * @param {number} [options.itemWidth]
 * @param {string} [options.homeDir]
 */
export function renderMarkdownLedger(result, { top = 10, sort = "output", itemWidth = 80, homeDir } = {}) {
  const sortKey = SORT_FIELDS.has(sort) ? sort : "output";
  const sanitized = sanitizeResultItems(result, { homeDir, itemWidth });
  const rows = flattenRows(sanitized.turns ?? []);
  rows.sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey));

  const total = rows.length;
  const shown = rows.slice(0, top);
  const hidden = total - shown.length;

  const sourceDisplay = sanitized.source === "exact" ? "精準命中" : "--latest fallback（非精準定位）";
  const totals = sanitized.totals ?? {};
  const lines = [];
  // F-I1: line-anchored metadata block — copy-paste-ready into
  // session-recap.md's `## Token 回顧` Template and machine-checkable by
  // recap-body-template-check.mjs's hasTokenSpendRecord (host:/session:/
  // source:/totals:/cost_usd:/gaps:, each at the start of a line). The bold
  // prose line below is presentational only and is NOT what the lint reads.
  lines.push(`- host: ${sanitized.host ?? ""}`);
  lines.push(`- session: ${sanitized.session ?? ""}`);
  lines.push(`- source: ${sourceDisplay}`);
  lines.push(`- usage_source: ${sanitized.usage_source ?? "not-reported"}`);
  lines.push(`- usage_segments: ${formatUsageSegments(sanitized.usage_segments)}`);
  lines.push(`- usage_reconciliation: ${sanitized.usage_reconciliation?.status ?? "not-reported"}`);
  lines.push(`- usage_attribution: ${formatUsageAttribution(sanitized)}`);
  lines.push(`- totals: ${formatTotalsFieldValue(totals, { hostTotals: sanitized.hostTotals, gaps: sanitized.gaps })}`);
  lines.push(`- cost_usd: ${formatCostUsdValue(sanitized)}`);
  lines.push(`- gaps: ${formatGapsFieldValue(sanitized.gaps)}`);
  lines.push("");
  lines.push(
    `**Token 花費明細** — host=${sanitized.host ?? ""} · session=${sanitized.session} · source=${sourceDisplay} · sort=${sortKey} · duration=wall-clock（非 API 時間）`,
  );
  lines.push("");
  lines.push(TABLE_HEADER);
  lines.push(TABLE_DELIMITER);
  for (const row of shown) {
    lines.push(
      `| ${formatCell(row.ts)} | ${formatDuration(row.duration_ms)} | ${row.actor} | ${row.item} | ${formatCell(row.tokens.input)} | ${formatCell(row.tokens.output)} | ${formatCell(row.tokens.cache_read)} | ${formatCell(row.tokens.cache_creation)} |`,
    );
  }
  const cacheCreationReason = cacheCreationReasonFor(sanitized);
  if (cacheCreationReason) {
    lines.push("");
    lines.push(`> cache_creation: N/A: ${cacheCreationReason}`);
  }
  if (hidden > 0) {
    lines.push("");
    lines.push(
      `> 已截斷：顯示 ${formatDisplayNumber(shown.length)} / 共 ${formatDisplayNumber(total)} 列（sort=${sortKey}，由大到小）；未顯示 ${formatDisplayNumber(hidden)} 列。完整明細見 --json。`,
    );
  }

  lines.push("");
  lines.push(
    `**totals** — input=${formatCell(totals.input)}（${sanitized.host === "codex" ? "input_tokens − cached_input_tokens" : "usage.input_tokens 原值"}） · output=${formatCell(totals.output)} · cache_read=${formatCell(totals.cache_read)}（billable sum，非 peak-context） · cache_creation=${formatCell(totals.cache_creation)}`,
  );

  return lines.join("\n");
}

function cacheCreationReasonFor(result) {
  return result.field_availability?.cache_creation === "unverified-on-host"
    ? "host 未提供 cache-creation 計數"
    : null;
}
