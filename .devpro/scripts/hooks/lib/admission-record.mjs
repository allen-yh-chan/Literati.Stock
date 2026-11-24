/**
 * Spawn admission record (strengthen-subagent-delegation-strategy design D6
 * (2.1)/(2.1a)/(2.2)/(2.6), D15).
 *
 * Legacy named-agent admission parses six bounded `key: value` lines from a
 * plaintext prompt and writes v1. Every host-observed Codex
 * `agent_type=dp-reviewer`, including an opaque message, instead consumes one
 * unique live prepared intent and writes v2 with per-field provenance. Both
 * paths durably create worktree-local records under the change's
 * `admission-records/`; the gate returns the record id/digest through
 * additionalContext while receipts re-read and bind the corresponding
 * authority artifacts rather than trusting conversation text.
 */
import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, truncateSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { TextDecoder } from "node:util";
import { CHANGE_ID_SHAPE, UUID_V4_SHAPE, createExclusiveDurableFile, fsyncDirectory, isDurablePathError, readNoFollowFile, verifyParentPath } from "../../lib/durable-fs.mjs";
import { PII_EMAIL_ALLOW_RE, PII_EMAIL_RE, PII_UNIX_HOME_RE, PII_UNIX_USERS_RE, PII_WINDOWS_USERS_RE } from "../../lib/pii-pattern-contract.mjs";
import { isProtectedBaseBranch, parseBranchName } from "./branch-naming.mjs";

export const ADMISSION_RECORD_SCHEMA = "devpro.spawn-admission-record/v1";
export const CODEX_REVIEWER_REQUEST_SCHEMA = "devpro.codex-reviewer-admission-request/v1";
export const CODEX_REVIEWER_RECOVERY_REQUEST_SCHEMA = "devpro.codex-reviewer-admission-recovery-request/v1";
export const CODEX_REVIEWER_INTENT_SCHEMA = "devpro.codex-reviewer-admission-intent/v1";
export const CODEX_REVIEWER_INTENT_CLAIM_SCHEMA = "devpro.codex-reviewer-admission-intent-claim/v1";
export const CODEX_REVIEWER_ADMISSION_SCHEMA = "devpro.spawn-admission-record/v2";
export const CODEX_REVIEWER_REQUEST_KEYS = Object.freeze([
  "schema", "change_id", "base_sha", "head_sha", "objective", "responsibility_id", "instance_mode",
  "evidence_scope", "return_and_stop", "role", "agent_type", "task_name", "fork_turns", "context_mode", "ttl_seconds",
]);
export const CODEX_REVIEWER_RECOVERY_REQUEST_KEYS = Object.freeze(["schema", "change_id", "intent_id", "intent_sha256"]);
export const CODEX_REVIEWER_INTENT_KEYS = Object.freeze([
  "schema", "intent_id", "canonical_worktree_sha256", "change_id", "base_sha", "head_sha", "objective",
  "responsibility_id", "instance_mode", "evidence_scope", "return_and_stop", "role", "agent_type", "task_name",
  "fork_turns", "context_mode", "issued_at", "expires_at",
]);
export const CODEX_REVIEWER_INTENT_CLAIM_KEYS = Object.freeze(["schema", "intent_id", "intent_sha256", "record_id", "claimed_at"]);
export const CODEX_REVIEWER_ADMISSION_KEYS = Object.freeze([
  "schema", "record_id", "intent_id", "intent_sha256", "change_id", "host", "admitted_at",
  "canonical_worktree_sha256", "base_sha", "head_sha", "objective", "responsibility_id", "instance_mode",
  "evidence_scope", "return_and_stop", "role", "agent_type", "task_name", "fork_turns", "context_mode", "role_binding", "provenance",
]);
export const ADMISSION_ROLES = Object.freeze([
  "dp-analyst", "dp-architect", "dp-reviewer", "dp-second-reviewer", "dp-programmer", "dp-assistant", "dp-explorer",
]);
/**
 * Review／verify role class (strengthen-admission-binding-portability design
 * D5): a dispatch declaring one of these roles MUST fail closed when no change
 * binding resolves, while every other registered role takes the non-silent
 * `binding-unresolved` advisory without minting. Every `ADMISSION_ROLES` member
 * MUST fall in exactly one class; the covering test asserts the classification
 * stays in step with the role registry, so a newly registered role the table
 * misses fails that test.
 */
export const ADMISSION_REVIEW_ROLES = Object.freeze(["dp-reviewer", "dp-second-reviewer"]);

export function classifyAdmissionRoleClass(role) {
  return ADMISSION_REVIEW_ROLES.includes(role) ? "review" : "advisory";
}
export const ADMISSION_OBJECTIVES = Object.freeze(["parallel-latency", "context-isolation", "independent-judgment", "specialized-surface"]);
export const ADMISSION_INSTANCE_MODES = Object.freeze(["fresh", "continue", "fork"]);
export const ADMISSION_REPLACEMENT_REASONS = Object.freeze(["context-growth", "independence", "rule-leaf-changed", "identity-lost", "terminal", "concurrency-slot"]);
export const ADMISSION_REQUIRED_FIELDS = Object.freeze(["objective", "responsibility_id", "instance_mode", "evidence_scope", "return_and_stop", "role"]);
// Positive missing / unsafe / mutation evidence only. Transient observation
// faults such as EIO/EACCES/EPERM MUST NOT invalidate after the commit point
// when the normal verifier can still accept the unchanged record (D2/D10).
const ADMISSION_READBACK_INVALIDATING_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "parent-not-plain-directory",
  "parent-outside-root",
  "target-not-in-parent",
  "target-not-regular-file",
  "same-inode-proof-failed",
  "target-oversize",
  "target-outside-parent",
  "file-changed-while-reading",
]);
// `FIELD_LINE` is the single carrier of the accepted key set (`ADMISSION_REQUIRED_FIELDS`
// carries which of them are unconditionally required). `parent_record_id` is
// conditional rather than optional: exactly required when `instance_mode` is
// `continue` (D34) and exactly forbidden otherwise. It names the record this
// dispatch continues, so the receipt gate can walk the chain back to the
// responsibility thread's fresh root. `change_id` and `execution_root` are the
// declared-path conditional fields (strengthen-admission-binding-portability
// design D6): their canonical position in the admission prompt block is between
// `return_and_stop` and `role`, and the `parent_record_id` position is
// unchanged. The value group is `(.*)` so an explicitly empty conditional value
// is diagnosed as a shape failure instead of silently reading as absent.
const FIELD_LINE = /^(objective|responsibility_id|instance_mode|evidence_scope|return_and_stop|change_id|execution_root|role|replacement_reason|fork_reason|parent_record_id):\s*(.*)$/;
const EMPTY_VALUE_SHAPE_KEYS = new Set(["change_id", "execution_root"]);
// Both separators: native Windows cwd (`C:\\…\\.worktree\\<change>`) and POSIX / Git Bash / forward-slash Windows shapes.
const WORKTREE_CHANGE_NAME_PATTERN = /\.worktree[\\/]([^\\/]+)(?:[\\/]|$)/;
const RESPONSIBILITY_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
// The record is worktree-local (gitignored) but readable by anyone with the
// worktree and quotable into PR bodies and receipts, so the TL-typed free-text
// values must satisfy the same PII contract as the OpenSpec docs (Gate P):
// no user-home absolute path, no non-allowlisted email. Repo-relative paths,
// symbols, commands and URLs stay valid `evidence_scope` carriers.
const FREE_TEXT_FIELDS = Object.freeze(["evidence_scope", "return_and_stop", "fork_reason"]);
const stateless = (re) => new RegExp(re.source, re.flags.replace("g", ""));
const UNSAFE_PATH_PATTERNS = [PII_UNIX_USERS_RE, PII_UNIX_HOME_RE, PII_WINDOWS_USERS_RE].map(stateless);
const EMAIL_PATTERN = new RegExp(PII_EMAIL_RE.source, PII_EMAIL_RE.flags.includes("g") ? PII_EMAIL_RE.flags : `${PII_EMAIL_RE.flags}g`);
const BOUND_BYTES = 8192;
const BOUND_LINES = 100;
// Per-field ceilings: `fork_reason` stays at the historical 500-char sentence
// cap (spec-bound). `evidence_scope` is a path/symbol list and uses 2000.
// Every other parsed key defaults to 500 — never raise the shared default to
// relax `fork_reason`. `change_id` 500 and `execution_root` 1024 are the
// declared-path conditional ceilings (design D6).
export const ADMISSION_FIELD_VALUE_MAX = Object.freeze({
  objective: 500,
  responsibility_id: 500,
  instance_mode: 500,
  evidence_scope: 2000,
  return_and_stop: 500,
  change_id: 500,
  execution_root: 1024,
  role: 500,
  replacement_reason: 500,
  fork_reason: 500,
  parent_record_id: 500,
});
const DEFAULT_FIELD_VALUE_MAX = 500;

export function admissionFieldValueMax(key) {
  return ADMISSION_FIELD_VALUE_MAX[key] ?? DEFAULT_FIELD_VALUE_MAX;
}

export class StrictJsonError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function decodeStrictUtf8(bytes, code = "artifact-unparseable") {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new StrictJsonError(code);
  }
}

export function readBoundedRequestFile(requestPath, maxBytes = 64 * 1024, { propagateNativeFaults = false, readNoFollowFileHooks = {} } = {}) {
  if (typeof requestPath !== "string" || requestPath.length === 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return { ok: false, code: "request-unparseable" };
  }
  const target = path.resolve(requestPath);
  const parent = path.dirname(target);
  try {
    const { bytes } = readNoFollowFile({ root: parent, parent, target, maxBytes, hooks: readNoFollowFileHooks });
    return { ok: true, bytes };
  } catch (error) {
    if (propagateNativeFaults && !isDurablePathError(error)) throw error;
    return { ok: false, code: error?.code === "target-oversize" ? "request-size-exceeded" : "request-unparseable" };
  }
}

export function parseJsonDuplicateAware(text, code = "artifact-unparseable") {
  let index = 0;
  const bad = () => { throw new StrictJsonError(code); };
  const whitespace = () => { while (/\s/u.test(text[index] ?? "")) index += 1; };
  const string = () => {
    if (text[index] !== '"') bad();
    const start = index++;
    while (index < text.length) {
      if (text.charCodeAt(index) < 0x20) bad();
      if (text[index] === '"') {
        index += 1;
        try { return JSON.parse(text.slice(start, index)); } catch { bad(); }
      }
      if (text[index] === "\\") {
        index += 1;
        if (text[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) bad();
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(text[index] ?? "")) bad();
      }
      index += 1;
    }
    bad();
  };
  const number = () => {
    const match = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) bad();
    index += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) bad();
    return parsed;
  };
  const array = () => {
    const result = [];
    index += 1;
    whitespace();
    if (text[index] === "]") { index += 1; return result; }
    while (index < text.length) {
      result.push(value());
      whitespace();
      if (text[index] === "]") { index += 1; return result; }
      if (text[index] !== ",") bad();
      index += 1;
      whitespace();
    }
    bad();
  };
  const object = () => {
    const result = {};
    const seen = new Set();
    index += 1;
    whitespace();
    if (text[index] === "}") { index += 1; return result; }
    while (index < text.length) {
      const key = string();
      if (seen.has(key)) bad();
      seen.add(key);
      whitespace();
      if (text[index] !== ":") bad();
      index += 1;
      result[key] = value();
      whitespace();
      if (text[index] === "}") { index += 1; return result; }
      if (text[index] !== ",") bad();
      index += 1;
      whitespace();
    }
    bad();
  };
  const value = () => {
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === "{") return object();
    if (text[index] === "[") return array();
    for (const [token, result] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(token, index)) { index += token.length; return result; }
    }
    return number();
  };
  const parsed = value();
  whitespace();
  if (index !== text.length) bad();
  return parsed;
}

export function hasExactOrderedKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function prettyJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Bounded plaintext parse of the admission fields; never returns the prompt itself. */
/**
 * The bounded prompt header the admission gate reads: the first 8 KiB of the
 * prompt, and of that at most 100 lines. When the prompt runs past the byte
 * bound, the last line of the prefix may have been cut mid-value or even
 * mid-character, so it is dropped unless the byte right after the bound proves
 * the line complete: a field is admitted whole or not at all, never as the
 * truncated prefix of its real value (cross-model second review on PR #2473,
 * head 19bd611c, CRITICAL 2). Shared by every reader of the header so the
 * bound cannot drift between the field parser and the fork-reason check.
 */
export function boundedPromptHeaderLines(prompt) {
  if (typeof prompt !== "string") return [];
  const bytes = Buffer.from(prompt, "utf8");
  let prefix = bytes.subarray(0, BOUND_BYTES);
  if (bytes.length > BOUND_BYTES) {
    const next = bytes[BOUND_BYTES];
    const lastLineComplete = next === 0x0a || (next === 0x0d && bytes[BOUND_BYTES + 1] === 0x0a);
    if (!lastLineComplete) {
      const lastNewline = prefix.lastIndexOf(0x0a);
      prefix = prefix.subarray(0, lastNewline < 0 ? 0 : lastNewline);
    }
  }
  return prefix.toString("utf8").split(/\r?\n/, BOUND_LINES);
}

export function parseAdmissionFields(prompt) {
  const fields = {};
  const invalid = [];
  const oversize = [];
  const oversizeKeys = new Set();
  if (typeof prompt === "string") {
    for (const line of boundedPromptHeaderLines(prompt)) {
      const match = line.match(FIELD_LINE);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (Object.prototype.hasOwnProperty.call(fields, key) || oversizeKeys.has(key)) continue; // first occurrence wins
      const value = rawValue.trim();
      // An explicitly empty value stays "not present" for every key except the
      // two conditional declared-path keys, whose empty shape is diagnosed
      // below instead of reading as an absent field.
      if (value.length === 0 && !EMPTY_VALUE_SHAPE_KEYS.has(key)) continue;
      const max = admissionFieldValueMax(key);
      if (value.length > max) {
        oversizeKeys.add(key);
        oversize.push({ field: key, length: value.length, max });
        continue;
      }
      fields[key] = value;
    }
  }
  // Oversized keys were present but too long — never report them as missing.
  const missing = ADMISSION_REQUIRED_FIELDS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(fields, key) && !oversizeKeys.has(key),
  );
  if (fields.objective !== undefined && !ADMISSION_OBJECTIVES.includes(fields.objective)) invalid.push("objective");
  if (fields.instance_mode !== undefined && !ADMISSION_INSTANCE_MODES.includes(fields.instance_mode)) invalid.push("instance_mode");
  if (fields.role !== undefined && !ADMISSION_ROLES.includes(fields.role)) invalid.push("role");
  if (fields.responsibility_id !== undefined && !RESPONSIBILITY_ID_SHAPE.test(fields.responsibility_id)) invalid.push("responsibility_id");
  if (fields.change_id !== undefined && !CHANGE_ID_SHAPE.test(fields.change_id)) invalid.push("change_id");
  if (fields.execution_root !== undefined && fields.execution_root.length === 0) invalid.push("execution_root");
  if (fields.replacement_reason !== undefined && !ADMISSION_REPLACEMENT_REASONS.includes(fields.replacement_reason)) invalid.push("replacement_reason");
  if (fields.parent_record_id !== undefined && !UUID_V4_SHAPE.test(fields.parent_record_id)) invalid.push("parent_record_id");
  else if (fields.instance_mode === "continue" && fields.parent_record_id === undefined && !oversizeKeys.has("parent_record_id")) {
    missing.push("parent_record_id");
  }
  else if (fields.parent_record_id !== undefined && fields.instance_mode !== "continue") invalid.push("parent_record_id");
  return { fields, missing, invalid: [...new Set(invalid)], oversize };
}

/** Closed-set / shape diagnosis for one invalid field; never collapses causes. */
function describeInvalidAdmissionField(field, fields) {
  const value = fields?.[field];
  if (field === "objective") {
    return `objective=${JSON.stringify(value)} (allowed: ${ADMISSION_OBJECTIVES.join("|")})`;
  }
  if (field === "instance_mode") {
    return `instance_mode=${JSON.stringify(value)} (allowed: ${ADMISSION_INSTANCE_MODES.join("|")})`;
  }
  if (field === "role") {
    return `role=${JSON.stringify(value)} (allowed: ${ADMISSION_ROLES.join("|")})`;
  }
  if (field === "replacement_reason") {
    return `replacement_reason=${JSON.stringify(value)} (allowed: ${ADMISSION_REPLACEMENT_REASONS.join("|")})`;
  }
  if (field === "responsibility_id") {
    return "responsibility_id shape invalid (must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$)";
  }
  if (field === "change_id") {
    return "change_id shape invalid (must match ^[a-z0-9][a-z0-9-]{0,99}$)";
  }
  if (field === "execution_root") {
    return "execution_root must be a non-empty absolute binding worktree path";
  }
  if (field === "parent_record_id") {
    if (fields?.instance_mode !== "continue") {
      return "parent_record_id is only allowed when instance_mode is continue";
    }
    return "parent_record_id must be a UUID v4";
  }
  return field;
}

/**
 * Formats parseAdmissionFields problems for gate block messages.
 * Order: oversize → invalid (with closed-set detail) → missing.
 * Returns null when there is nothing to report.
 */
export function formatAdmissionFieldProblems(parsed) {
  const parts = [];
  const oversize = Array.isArray(parsed?.oversize) ? parsed.oversize : [];
  if (oversize.length > 0) {
    parts.push(
      `oversize: ${oversize.map((row) => `${row.field} length=${row.length} max=${row.max}`).join(", ")}`,
    );
  }
  const invalid = Array.isArray(parsed?.invalid) ? parsed.invalid : [];
  if (invalid.length > 0) {
    parts.push(
      `admission record field(s) invalid: ${invalid.map((field) => describeInvalidAdmissionField(field, parsed.fields)).join("; ")}`,
    );
  }
  const missing = Array.isArray(parsed?.missing) ? parsed.missing : [];
  if (missing.length > 0) {
    parts.push(
      `admission record requires the six fields as \`key: value\` lines within the first 8 KiB / 100 lines of the prompt; missing: ${missing.join(", ")}`,
    );
  }
  return parts.length > 0 ? parts.join(" — ") : null;
}

/** First free-text field carrying a user-home absolute path or a non-allowlisted email, else null. */
export function unsafeAdmissionField(fields) {
  for (const key of FREE_TEXT_FIELDS) {
    const value = fields?.[key];
    if (typeof value !== "string") continue;
    if (UNSAFE_PATH_PATTERNS.some((re) => re.test(value))) return key;
    for (const match of value.matchAll(EMAIL_PATTERN)) {
      if (!PII_EMAIL_ALLOW_RE.test(match[0])) return key;
    }
  }
  return null;
}

/**
 * The `.worktree/<name>` segment extractor is duplicated in
 * `context-headroom-gate.mjs` (`resolveChangeNameFromWorktreeCwd`) with the
 * same regex but deliberately different semantics: Gate CH accepts the raw
 * directory name because it only labels telemetry, while this path additionally
 * enforces `CHANGE_ID_SHAPE` because the name becomes a filesystem write target.
 * Keep both in step — changing one alone drifts silently
 * (r15 F-r15-worktree-change-name-pattern-duplicated-across-two-hook-modules).
 */
export function resolveChangeIdFromCwd(cwd) {
  const match = WORKTREE_CHANGE_NAME_PATTERN.exec(String(cwd || ""));
  const candidate = match ? match[1] : null;
  return candidate && CHANGE_ID_SHAPE.test(candidate) ? candidate : null;
}

function git(cwd, args, hooks = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (hooks.propagateNativeFaults && (result.error || result.status !== 0)) {
    throw result.error ?? new Error("unlisted Git result");
  }
  if (result.status !== 0) return null;
  return String(result.stdout || "").trim();
}

function runGit(cwd, args, hooks = {}) {
  if (typeof hooks.git === "function") return hooks.git(cwd, args);
  return git(cwd, args, hooks);
}

// `git worktree list --porcelain -z`: attributes are NUL-terminated; an empty
// attribute (double NUL) ends one worktree record. Uniqueness is only valid on
// a complete parse — truncated / mid-record output MUST fail closed.
function parseWorktreePorcelainZ(raw) {
  if (typeof raw !== "string") return { ok: false };
  if (raw.length === 0) return { ok: true, worktrees: [] };
  const parts = raw.split("\0");
  // A complete listing ends with a trailing empty field after the final record
  // separator. A bare non-empty tail without that terminator is truncated.
  if (parts.length < 2 || parts[parts.length - 1] !== "") return { ok: false };
  const worktrees = [];
  let current = null;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (part === "") {
      if (current === null || typeof current.path !== "string" || current.path.length === 0) {
        return { ok: false };
      }
      worktrees.push(current);
      current = null;
      continue;
    }
    if (current === null) current = {};
    if (part.startsWith("worktree ")) {
      if (Object.hasOwn(current, "path")) return { ok: false };
      current.path = part.slice("worktree ".length);
      continue;
    }
    if (part.startsWith("HEAD ")) {
      current.head = part.slice("HEAD ".length);
      continue;
    }
    // Ignore branch/detached/locked/prunable attributes for admission.
  }
  if (current !== null) return { ok: false };
  return { ok: true, worktrees };
}

/**
 * Writes the admission record; returns `{ ok: true, record_id, digest }` or
 * `{ ok: false, code }` (codes are stable tokens, never raw paths).
 */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function changeDirOf(repoRoot, changeId) {
  return path.join(repoRoot, "openspec", "changes", changeId);
}

function plainDirectory(target, propagateNativeFaults = false) {
  try {
    const stat = lstatSync(target);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch (error) {
    if (propagateNativeFaults && error?.code !== "ENOENT") throw error;
    return false;
  }
}

// The containment anchor is the repository root, not the change directory:
// every component below the root (`openspec/`, `openspec/changes/`, the
// `archive/` entry, the change folder itself) is lstat'ed without following
// links and the resolved path must stay inside the resolved root. A symlinked
// intermediate used to pass every leaf-only check and redirect create, read,
// claim, and release outside the repository (cross-model second review on
// PR #2473, head 19bd611c, CRITICAL 1). D15's threat model names "mistaken
// symlinks" in scope, and a link above the leaf is exactly that.
function anchoredPlainDirectory(repoRoot, target, propagateNativeFaults = false) {
  if (!plainDirectory(target, propagateNativeFaults)) return false;
  try {
    verifyParentPath(repoRoot, target);
    return true;
  } catch (error) {
    if (propagateNativeFaults && !isDurablePathError(error)) throw error;
    return false;
  }
}

// D51: "the change folder is not there" and "the change folder is there but is
// not usable" are different conditions and MUST NOT collapse into one verdict.
// chore-A entry (a) builds a worktree straight from an anchor SHA without ever
// creating `openspec/changes/<change_id>/` (免 OpenSpec, no `/devpro:change`),
// while its 共同不變式 still makes the dp-assistant dispatch mandatory — so an
// absent folder has to pass without a record, exactly like the Codex carrier
// that ships no prompt text, leaving `admission-records-unavailable` (reason
// `admission-records-dir-missing`) as the lineage audit surface. Anything that
// does exist at either location but is not a plain directory — a symlink above
// all — stays fail closed: that is D15 (2)'s protection, and turning it into a
// pass would let a planted link silence the gate. Absence itself must be proven
// (ENOENT); an entry whose state cannot be read is not absent (r15
// F-r15-absent-verdict-swallows-non-enoent-lstat-and-readdir-faults).
export function admissionChangeEntryExists(repoRoot, changeId, { propagateNativeFaults = false } = {}) {
  if (typeof repoRoot !== "string" || !repoRoot || typeof changeId !== "string" || !CHANGE_ID_SHAPE.test(changeId)) return false;
  const entryAnchor = propagateNativeFaults ? repoRoot : undefined;
  if (entryExists(changeDirOf(repoRoot, changeId), propagateNativeFaults, entryAnchor)) return true;
  const archiveRoot = path.join(repoRoot, "openspec", "changes", "archive");
  // Probe absence before enumeration. Once the directory was observed to
  // exist, an ENOENT from readdirSync is a race/native fault, not evidence that
  // no archived entry exists.
  if (!entryExists(archiveRoot, propagateNativeFaults, entryAnchor)) return false;
  let names;
  try {
    names = readdirSync(archiveRoot);
  } catch (error) {
    if (propagateNativeFaults && (error?.code === "ENOENT" || !isDurablePathError(error))) throw error;
    // Any non-ENOENT fault leaves absence unproven, so it fails closed. In
    // opted-in mode ENOENT here follows the successful existence probe above
    // and therefore propagates as an enumeration race.
    return error?.code !== "ENOENT";
  }
  // C-03: `readdirSync` follows symlinks, so a planted link at any component of
  // `openspec/changes/archive` used to read an unrelated (often empty) directory
  // and report proven absence — the one verdict that PASSES a spawn without a
  // record. The sibling resolver rejects exactly that tree because every
  // candidate goes through `anchoredPlainDirectory`, which walks from repoRoot;
  // anchoring the prober the same way keeps the two from disagreeing about one
  // tree. A carrier that is not repo-root-contained proves nothing about
  // absence, so it fails closed (Done When 8: absence must be proven).
  try {
    verifyParentPath(repoRoot, archiveRoot);
  } catch (error) {
    if (propagateNativeFaults && !isDurablePathError(error)) throw error;
    return true;
  }
  const pattern = /^\d{4}-\d{2}-\d{2}-(.+)$/;
  return names.some((name) => pattern.exec(name)?.[1] === changeId
    && entryExists(path.join(archiveRoot, name), propagateNativeFaults, entryAnchor));
}

// Opted-in D30 reads must distinguish a missing entry from an ENOENT caused by
// a dangling symlink above it. lstat the path components under the trusted
// repository root before probing the leaf, without resolving or following any
// link. The default shared-helper path keeps its established behavior.
function unsafeOrMissingParent(repoRoot, target, propagateNativeFaults) {
  const root = path.resolve(repoRoot);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(root, absoluteTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "unsafe";
  const segments = relative.split(path.sep).filter(Boolean).slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return "missing";
      if (propagateNativeFaults) throw error;
      return "unsafe";
    }
    if (stat.isSymbolicLink()) return "unsafe";
    if (!stat.isDirectory()) {
      // POSIX reports ENOTDIR when a later path component is probed through a
      // regular file. Windows may report ENOENT for the same path. In the
      // opted-in native-fault path, preserve that distinction explicitly so a
      // file blocking a directory path cannot be mistaken for proven absence.
      if (propagateNativeFaults) {
        const error = new Error("path component is not a directory");
        error.code = "ENOTDIR";
        throw error;
      }
      return "unsafe";
    }
  }
  return "clear";
}

function entryExists(target, propagateNativeFaults = false, anchorRoot) {
  if (anchorRoot !== undefined) {
    const parentState = unsafeOrMissingParent(anchorRoot, target, propagateNativeFaults);
    if (parentState === "unsafe") return true;
    if (parentState === "missing") return false;
  }
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (propagateNativeFaults && error?.code !== "ENOENT") throw error;
    // "No entry at all" is exactly ENOENT. Every other fault — ENOTDIR when a
    // path component is not a directory, EACCES when a parent lacks `+x` — says
    // the entry may well be there and is merely unreadable, which is not proof
    // of absence, so it reports presence and the caller fails closed.
    return error?.code !== "ENOENT";
  }
}

/**
 * Read-side change directory resolution: the active folder while the change is
 * open. Archive fallback is allowed only when the active entry is proven
 * absent; an existing invalid active entry blocks instead of being hidden by a
 * valid archive. The archived folder is
 * `openspec/changes/archive/<YYYY-MM-DD>-<change_id>` (latest by name when
 * several exist). Records move with the folder at `openspec archive`, so
 * post-archive receipt verification (pre-PR seal-final, lineage telemetry)
 * still resolves them. Symlinked entries never resolve.
 */
export function resolveAdmissionChangeDir(repoRoot, changeId, { propagateNativeFaults = false } = {}) {
  if (typeof repoRoot !== "string" || !repoRoot || typeof changeId !== "string" || !CHANGE_ID_SHAPE.test(changeId)) return null;
  const entryAnchor = propagateNativeFaults ? repoRoot : undefined;
  const active = changeDirOf(repoRoot, changeId);
  if (anchoredPlainDirectory(repoRoot, active, propagateNativeFaults)) return active;
  if (entryExists(active, propagateNativeFaults, entryAnchor)) return null;
  const archiveRoot = path.join(repoRoot, "openspec", "changes", "archive");
  // Distinguish a proven-missing archive from an ENOENT race during the read.
  if (!entryExists(archiveRoot, propagateNativeFaults, entryAnchor)) return null;
  let names;
  try {
    names = readdirSync(archiveRoot);
  } catch (error) {
    if (propagateNativeFaults) throw error;
    return null;
  }
  const pattern = /^\d{4}-\d{2}-\d{2}-(.+)$/;
  const matches = names
    .filter((name) => pattern.exec(name)?.[1] === changeId && anchoredPlainDirectory(repoRoot, path.join(archiveRoot, name), propagateNativeFaults))
    .sort();
  return matches.length > 0 ? path.join(archiveRoot, matches.at(-1)) : null;
}

const RECORD_MAX_BYTES = 64 * 1024;

/**
 * Declared-path `execution_root` contract (strengthen-admission-binding-portability
 * design D4.1／D4.2): when the binding was resolved from a declaration rather
 * than a `.worktree/<id>` cwd, every dispatch — any role, fork and continuation
 * carriers included — MUST carry `execution_root` naming the absolute binding
 * worktree. A missing value fails closed with `execution-root-required`; a value
 * that does not realpath-equal the resolved binding root (a relative path, a
 * nonexistent path, or another worktree) fails closed with
 * `execution-root-mismatch`, and a relative value is rejected before any
 * cwd-anchored resolution, so the hook process cwd can never complete a
 * declared value. The cwd fast path is exempt: there the environment itself
 * proves the root, so the field is ignored. `execution_root` is an input
 * contract only — it is validated here and never persisted into the record.
 */
function declaredExecutionRootProblem(bindingRoot, fields) {
  const value = fields?.execution_root;
  if (typeof value !== "string" || value.length === 0) return "execution-root-required";
  // Platform-aware absolute-path precondition (cross-model CM-1): `path.resolve`
  // anchors a relative value at the hook process cwd, so a relative value that
  // happens to name the binding root from there used to realpath-equal it and
  // pass. The canonical contract admits only an absolute binding-worktree path
  // — "a relative path ... MUST fail closed with `execution-root-mismatch`" —
  // so the check runs before any resolution and uses the running platform's
  // own semantics (`path.isAbsolute`), never a hand-rolled prefix test.
  if (!path.isAbsolute(value)) return "execution-root-mismatch";
  let declared;
  let resolved;
  try {
    declared = realpathSync(path.resolve(value));
  } catch {
    return "execution-root-mismatch";
  }
  try {
    resolved = realpathSync(bindingRoot);
  } catch {
    return "execution-root-mismatch";
  }
  return declared === resolved ? null : "execution-root-mismatch";
}

/**
 * Durable admission record writer (design D6 (2.1)/(2.6), D15 (B) Create;
 * strengthen-admission-binding-portability D3).
 * The binding (`repoRoot`／`changeId`／`headSha`／`changeDir`) comes from the one
 * shared `resolveAdmissionBinding`, so a main-rooted declared dispatch writes
 * into the exact-one binding worktree with that worktree's HEAD and never into
 * the spawn cwd's checkout. The change directory MUST already exist as a plain
 * directory (never created here, never a symlink); only `admission-records/` is
 * created, non-recursively. It is resolved through the same active-or-archived
 * `resolveAdmissionChangeDir` the reader uses, so a dispatch made after
 * `openspec archive` (pre-PR Step 5.5 cross-review) still writes next to the
 * records it will be verified against instead of failing closed on the folder
 * the archive step just moved. D51 now requires a binding: with none resolved
 * the result carries `noDeclaration` for the caller's role classification
 * instead of the change-folder-absent pass. A declared-path binding additionally
 * enforces the `execution_root` contract (D4) before any record bytes are
 * written — `execution-root-required`／`execution-root-mismatch` carry the
 * resolved binding root for the operator but never persist it. On success the
 * result carries `bindingPath` (`cwd-fast`／`declared`) alongside the resolved
 * `bindingRoot`, so the caller can keep the declared-path admission handoff
 * operator-visible without persisting the root. `uuid` and `hooks` are test
 * injection points only.
 */
export function writeAdmissionRecord({ cwd, host, prompt, fields, roleBinding, now = () => new Date(), uuid = randomUUID, hooks = {} }) {
  const binding = resolveAdmissionBinding({ cwd, fields, hooks });
  if (!binding.ok) {
    return {
      ok: false,
      code: binding.code,
      ...(binding.noDeclaration === true ? { noDeclaration: true } : {}),
      ...(typeof binding.bindingRoot === "string" ? { bindingRoot: binding.bindingRoot } : {}),
    };
  }
  if (binding.path === "declared") {
    // D4: the declared path always carries the execution root contract — the
    // resolved binding root is operator-visible in the failure (never persisted).
    const problem = declaredExecutionRootProblem(binding.repoRoot, fields);
    if (problem !== null) return { ok: false, code: problem, bindingRoot: binding.repoRoot };
  }
  const unsafeField = unsafeAdmissionField(fields);
  if (unsafeField) return { ok: false, code: "admission-record-unsafe-value", field: unsafeField, bindingRoot: binding.repoRoot };
  const { repoRoot, changeId, headSha, changeDir, advisories, path: bindingPath } = binding;
  const recordId = uuid();
  if (typeof recordId !== "string" || !UUID_V4_SHAPE.test(recordId)) return { ok: false, code: "admission-record-id-invalid" };
  const record = {
    schema: ADMISSION_RECORD_SCHEMA,
    record_id: recordId,
    change_id: changeId,
    host,
    admitted_at: now().toISOString(),
    head_sha: headSha,
    prompt_sha256: sha256(Buffer.from(String(prompt), "utf8")),
    objective: fields.objective,
    responsibility_id: fields.responsibility_id,
    instance_mode: fields.instance_mode,
    evidence_scope: fields.evidence_scope,
    return_and_stop: fields.return_and_stop,
    role: fields.role,
    role_binding: roleBinding,
    ...(fields.parent_record_id !== undefined ? { parent_record_id: fields.parent_record_id } : {}),
    ...(fields.replacement_reason !== undefined ? { replacement_reason: fields.replacement_reason } : {}),
    ...(fields.fork_reason !== undefined ? { fork_reason: fields.fork_reason } : {}),
  };
  if (changeDir === null) {
    // D51: absent everywhere → pass without a record; existing-but-not-plain → block.
    return admissionChangeEntryExists(repoRoot, changeId)
      ? { ok: false, code: "admission-records-dir-invalid", bindingRoot: repoRoot }
      : { ok: false, code: "change-dir-absent" };
  }
  const dir = path.join(changeDir, "admission-records");
  const { fsyncDir = fsyncDirectory } = hooks;
  try {
    const changeStat = lstatSync(changeDir);
    if (changeStat.isSymbolicLink() || !changeStat.isDirectory()) return { ok: false, code: "admission-records-dir-invalid", bindingRoot: repoRoot };
    try {
      mkdirSync(dir, { recursive: false, mode: 0o700 });
      // C-05: `createExclusiveDurableFile` fsyncs `dir` (which holds the record
      // file), never `changeDir` (which holds `dir`'s own mkdir entry). Without
      // this, the first record written into a change can survive a crash while
      // the `admission-records/` directory containing it does not — the same
      // parent-entry fsync `claimAdmissionRecord` already performs below.
      fsyncDir(changeDir);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } catch {
    return { ok: false, code: "admission-records-dir-invalid", bindingRoot: repoRoot };
  }
  const body = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  try {
    createExclusiveDurableFile({ root: repoRoot, parent: dir, target: path.join(dir, `${recordId}.json`), body, hooks });
  } catch (error) {
    const parentFault = error?.code === "parent-not-plain-directory" || error?.code === "parent-outside-root";
    return { ok: false, code: parentFault ? "admission-records-dir-invalid" : "admission-record-write-failed", bindingRoot: repoRoot };
  }
  return { ok: true, record_id: recordId, digest: sha256(body), advisories, bindingRoot: repoRoot, bindingPath };
}

/**
 * Admission record reader (design D15 (C) Read) shared by the receipt
 * producer / validator and the lineage loader. Identifier validation runs
 * before any filesystem access; non-D30 callers keep the collapsed result
 * contract while D30 may opt into native-fault propagation.
 */
export function readAdmissionRecord({ repoRoot, changeId, recordId, propagateNativeFaults = false, readNoFollowFileHooks = {} }) {
  if (typeof changeId !== "string" || !CHANGE_ID_SHAPE.test(changeId)) return { ok: false, code: "change-id-invalid" };
  if (typeof recordId !== "string" || !UUID_V4_SHAPE.test(recordId)) return { ok: false, code: "admission-record-id-invalid" };
  if (typeof repoRoot !== "string" || !repoRoot) return { ok: false, code: "repo-root-missing" };
  const changeDir = resolveAdmissionChangeDir(repoRoot, changeId, { propagateNativeFaults });
  if (changeDir === null) return { ok: false, code: "admission-record-unreadable" };
  const dir = path.join(changeDir, "admission-records");
  const target = path.join(dir, `${recordId}.json`);
  if (propagateNativeFaults) {
    try {
      lstatSync(target);
    } catch (error) {
      // A completed lstat ENOENT proves the referenced record is absent.
      // ENOENT from the following open is a race and must remain native.
      if (error?.code === "ENOENT") return { ok: false, code: "admission-record-unreadable" };
      throw error;
    }
  }
  let bytes;
  try {
    ({ bytes } = readNoFollowFile({ root: repoRoot, parent: dir, target, maxBytes: RECORD_MAX_BYTES, hooks: readNoFollowFileHooks }));
  } catch (error) {
    if (propagateNativeFaults && !isDurablePathError(error)) throw error;
    return { ok: false, code: "admission-record-unreadable" };
  }
  let record;
  try {
    record = recordSchemaFromBytes(bytes) === CODEX_REVIEWER_ADMISSION_SCHEMA
      ? parseJsonDuplicateAware(decodeStrictUtf8(bytes).slice(0, -1), "artifact-unparseable")
      : JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, code: "admission-record-malformed" };
  }
  if (!record || typeof record !== "object" || Array.isArray(record)
    || ![ADMISSION_RECORD_SCHEMA, CODEX_REVIEWER_ADMISSION_SCHEMA].includes(record.schema)
    || record.record_id !== recordId
    || (record.schema === CODEX_REVIEWER_ADMISSION_SCHEMA && (!prettyJsonBytes(record).equals(bytes) || !validateAdmissionRecordV2(record).ok))) {
    return { ok: false, code: "admission-record-malformed" };
  }
  return { ok: true, record, digest: sha256(bytes), bytes };
}

function recordSchemaFromBytes(bytes) {
  try {
    const text = decodeStrictUtf8(bytes);
    if (!text.endsWith("\n")) return null;
    return parseJsonDuplicateAware(text.slice(0, -1))?.schema ?? null;
  } catch {
    return null;
  }
}

export const ADMISSION_CLAIM_SCHEMA = "devpro.spawn-admission-claim/v1";
const CLAIM_MAX_BYTES = 8 * 1024;
const SHA_SHAPE = /^[0-9a-f]{40}$/;
const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

function claimTupleProblem(claim) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return "admission-claim-malformed";
  if (!Number.isSafeInteger(claim.round_number) || claim.round_number < 1) return "admission-claim-malformed";
  if (typeof claim.head_sha !== "string" || !SHA_SHAPE.test(claim.head_sha)) return "admission-claim-malformed";
  if (typeof claim.responsibility_id !== "string" || claim.responsibility_id.length === 0) return "admission-claim-malformed";
  if (typeof claim.dispatch_id !== "string" || !DIGEST_SHAPE.test(claim.dispatch_id)) return "admission-claim-malformed";
  return null;
}

function claimIdsProblem({ repoRoot, changeId, recordId }) {
  if (typeof changeId !== "string" || !CHANGE_ID_SHAPE.test(changeId)) return "change-id-invalid";
  if (typeof recordId !== "string" || !UUID_V4_SHAPE.test(recordId)) return "admission-record-id-invalid";
  if (typeof repoRoot !== "string" || !repoRoot) return "repo-root-missing";
  return null;
}

/**
 * Single-use consumption of an admission record (cross-model CRITICAL on
 * PR #2473). The receipt sealer used to prove single use by scanning the other
 * sealed receipts for the same `admission_record_id` — a check-then-write
 * race: two concurrent seals of different rounds both pass the scan and both
 * write. This is the same atomic shape `half-state-override.mjs` uses for
 * override consumption: `mkdirSync(<record_id>.claim/, { recursive: false })`
 * admits exactly one winner and ANY `EEXIST` is refused — there is no
 * idempotent-retry branch, because two callers claiming the same record is
 * precisely the state that must fail. The winner then durably writes
 * `consumed.json` carrying the receipt tuple it is consuming the record for,
 * so a later readback can prove the claim belongs to *that* receipt.
 *
 * What this does NOT prove: that the receipt was authored by the admitted
 * subagent. The record binds admission (role, responsibility, head, time),
 * not authorship — see `subagent-behavioral-contract` spec, `[cooperative-only]`.
 */
export function claimAdmissionRecord({ repoRoot, changeId, recordId, claim, now = () => new Date(), hooks = {}, propagateNativeFaults = false }) {
  const idsProblem = claimIdsProblem({ repoRoot, changeId, recordId });
  if (idsProblem) return { ok: false, code: idsProblem };
  const tupleProblem = claimTupleProblem(claim);
  if (tupleProblem) return { ok: false, code: tupleProblem };
  const loaded = readAdmissionRecord({ repoRoot, changeId, recordId, propagateNativeFaults });
  if (!loaded.ok) return loaded;
  const changeDir = resolveAdmissionChangeDir(repoRoot, changeId, { propagateNativeFaults });
  if (changeDir === null) return { ok: false, code: "admission-record-unreadable" };
  const dir = path.join(changeDir, "admission-records");
  try {
    verifyParentPath(repoRoot, dir);
  } catch (error) {
    if (propagateNativeFaults && !isDurablePathError(error)) throw error;
    return { ok: false, code: "admission-records-dir-invalid" };
  }
  const claimDir = path.join(dir, `${recordId}.claim`);
  try {
    (hooks.mkdirClaimSync ?? mkdirSync)(claimDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (propagateNativeFaults && error?.code !== "EEXIST") throw error;
    return { ok: false, code: error?.code === "EEXIST" ? "admission-record-already-claimed" : "admission-claim-write-failed" };
  }
  const { fsyncDir = fsyncDirectory } = hooks;
  try {
    fsyncDir(dir);
  } catch (error) {
    if (propagateNativeFaults) throw error;
    return { ok: false, code: "admission-claim-write-failed" };
  }
  const record = {
    schema: ADMISSION_CLAIM_SCHEMA,
    record_id: recordId,
    change_id: changeId,
    round_number: claim.round_number,
    head_sha: claim.head_sha,
    responsibility_id: claim.responsibility_id,
    dispatch_id: claim.dispatch_id,
    claimed_at: now().toISOString(),
  };
  try {
    createExclusiveDurableFile({
      root: repoRoot,
      parent: claimDir,
      target: path.join(claimDir, "consumed.json"),
      body: `${JSON.stringify(record, null, 2)}\n`,
      hooks,
    });
  } catch (error) {
    if (propagateNativeFaults && error?.code !== "EEXIST") throw error;
    // A half-written claim stays on disk on purpose: the record is now
    // ambiguous, and ambiguity must read as "claimed" (fail closed), never as
    // "free again".
    return { ok: false, code: "admission-claim-write-failed" };
  }
  return { ok: true, claim: record, path: path.join(claimDir, "consumed.json") };
}

/**
 * Reads the claim for a record. `claim: null` means proven absence — only
 * ENOENT on the claim directory counts, the same boundary `entryExists()`
 * draws for the record itself; any other fault reports unreadable so the
 * caller fails closed.
 */
export function readAdmissionRecordClaim({ repoRoot, changeId, recordId, propagateNativeFaults = false, readNoFollowFileHooks = {} }) {
  const idsProblem = claimIdsProblem({ repoRoot, changeId, recordId });
  if (idsProblem) return { ok: false, code: idsProblem };
  const changeDir = resolveAdmissionChangeDir(repoRoot, changeId, { propagateNativeFaults });
  if (changeDir === null) return { ok: false, code: "admission-record-unreadable" };
  const claimDir = path.join(changeDir, "admission-records", `${recordId}.claim`);
  let stat;
  try {
    stat = lstatSync(claimDir);
  } catch (error) {
    if (propagateNativeFaults && error?.code !== "ENOENT") throw error;
    return error?.code === "ENOENT" ? { ok: true, claim: null } : { ok: false, code: "admission-claim-unreadable" };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, code: "admission-claim-unreadable" };
  let bytes;
  try {
    ({ bytes } = readNoFollowFile({ root: repoRoot, parent: claimDir, target: path.join(claimDir, "consumed.json"), maxBytes: CLAIM_MAX_BYTES, hooks: readNoFollowFileHooks }));
  } catch (error) {
    if (propagateNativeFaults && !isDurablePathError(error)) throw error;
    return { ok: false, code: "admission-claim-unreadable" };
  }
  let claim;
  try {
    claim = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, code: "admission-claim-malformed" };
  }
  if (!claim || typeof claim !== "object" || Array.isArray(claim) || claim.schema !== ADMISSION_CLAIM_SCHEMA
    || claim.record_id !== recordId || claim.change_id !== changeId || claimTupleProblem(claim) !== null) {
    return { ok: false, code: "admission-claim-malformed" };
  }
  return { ok: true, claim };
}

const CODEX_REVIEWER_SHA = /^[0-9a-f]{40}$/u;
const CODEX_REVIEWER_DIGEST = /^[0-9a-f]{64}$/u;
const CODEX_REVIEWER_TASK_NAME = /^[a-z0-9][a-z0-9_]{0,99}$/u;
const CODEX_REVIEWER_STRUCTURED_MAX = 64 * 1024;
// Two independent budgets (fix-codex-reviewer-intent-candidate-cap D1). Their per-unit costs differ by about 230x
// (a worktree candidate costs ~3 git spawns, an intent entry ~0.3 ms), so one shared number was the wrong unit.
// Both budgets at their limit together: the full hook chain must stay <= 18 s in the slowest of 5 runs; measured by
// .devpro/scripts/bench-codex-reviewer-admission-latency.mjs, background in design-core.md §8.
// Unit: entries returned by `git worktree list --porcelain -z`, the main checkout included; 128 passes, 129 fails.
export const CODEX_REVIEWER_WORKTREE_LIST_MAX = 128;
// Unit: every entry `readdirSync(intentDir)` returns (.json, `${id}.claim/`, anything else), summed across all scanned
// intent directories; 8192 passes, 8193 fails. 4096 dispatch tickets x 2: a claimed ticket holds a .json and a .claim/.
// Same 18 s rule as above.
export const CODEX_REVIEWER_INTENT_ENTRY_MAX = 8192;

function codexReviewerError(code) {
  return { ok: false, code };
}

function codexReviewerScalarProblem(value) {
  if (!CHANGE_ID_SHAPE.test(value.change_id ?? "") || !UUID_V4_SHAPE.test(value.intent_id ?? "")) return "identifier-invalid";
  if (!CODEX_REVIEWER_SHA.test(value.base_sha ?? "") || !CODEX_REVIEWER_SHA.test(value.head_sha ?? "")) return "sha-invalid";
  if (!CODEX_REVIEWER_DIGEST.test(value.canonical_worktree_sha256 ?? "")) return "digest-invalid";
  if (!RESPONSIBILITY_ID_SHAPE.test(value.responsibility_id ?? "") || !CODEX_REVIEWER_TASK_NAME.test(value.task_name ?? "")) return "identifier-invalid";
  if (typeof value.evidence_scope !== "string" || value.evidence_scope.length === 0 || value.evidence_scope.length > admissionFieldValueMax("evidence_scope")
    || typeof value.return_and_stop !== "string" || value.return_and_stop.length === 0 || value.return_and_stop.length > admissionFieldValueMax("return_and_stop")) return "request-shape-invalid";
  if (value.objective !== "independent-judgment" || value.instance_mode !== "fresh" || value.role !== "dp-reviewer"
    || value.agent_type !== "dp-reviewer" || value.fork_turns !== "none" || value.context_mode !== "fresh") return "request-shape-invalid";
  return null;
}

function codexReviewerRequestProblem(request) {
  if (!hasExactOrderedKeys(request, CODEX_REVIEWER_REQUEST_KEYS) || request.schema !== CODEX_REVIEWER_REQUEST_SCHEMA) return "request-shape-invalid";
  const scalar = codexReviewerScalarProblem({
    ...request,
    intent_id: "00000000-0000-4000-8000-000000000000",
    canonical_worktree_sha256: "0".repeat(64),
  });
  if (scalar) return scalar;
  if (!Number.isSafeInteger(request.ttl_seconds) || request.ttl_seconds < 1) return "request-shape-invalid";
  return request.ttl_seconds > 600 ? "intent-ttl-exceeded" : null;
}

function codexReviewerRecoveryRequestProblem(request) {
  if (!hasExactOrderedKeys(request, CODEX_REVIEWER_RECOVERY_REQUEST_KEYS)
    || request.schema !== CODEX_REVIEWER_RECOVERY_REQUEST_SCHEMA
    || !CHANGE_ID_SHAPE.test(request.change_id ?? "")
    || !UUID_V4_SHAPE.test(request.intent_id ?? "")
    || !CODEX_REVIEWER_DIGEST.test(request.intent_sha256 ?? "")) return "request-shape-invalid";
  return null;
}

function ensureCodexReviewerDirectory(repoRoot, parent, target) {
  try {
    mkdirSync(target, { recursive: false, mode: 0o700 });
    fsyncDirectory(parent);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("artifact-parent-invalid");
  verifyParentPath(repoRoot, target);
}

export function issueCodexReviewerAdmission({ cwd, request, now = () => new Date(), uuid = randomUUID, hooks = {} }) {
  const problem = codexReviewerRequestProblem(request);
  if (problem) return codexReviewerError(problem);
  const changeId = resolveChangeIdFromCwd(cwd);
  const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
  const headSha = git(cwd, ["rev-parse", "HEAD"]);
  if (!changeId || !repoRoot || request.change_id !== changeId) return codexReviewerError("identifier-invalid");
  if (!headSha || request.head_sha !== headSha) return codexReviewerError("intent-tuple-mismatch");
  const intentId = uuid();
  if (!UUID_V4_SHAPE.test(intentId)) return codexReviewerError("identifier-invalid");
  const issuedAt = now();
  if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) return codexReviewerError("timestamp-invalid");
  const changeDir = resolveAdmissionChangeDir(repoRoot, changeId);
  if (changeDir === null) return codexReviewerError("artifact-parent-invalid");
  const admissionDir = path.join(changeDir, "admission-records");
  const intentDir = path.join(admissionDir, "codex-reviewer-intents");
  try {
    ensureCodexReviewerDirectory(repoRoot, changeDir, admissionDir);
    ensureCodexReviewerDirectory(repoRoot, admissionDir, intentDir);
  } catch {
    return codexReviewerError("artifact-parent-invalid");
  }
  const intent = {
    schema: CODEX_REVIEWER_INTENT_SCHEMA,
    intent_id: intentId,
    canonical_worktree_sha256: sha256(Buffer.from(realpathSync(cwd), "utf8")),
    change_id: changeId,
    base_sha: request.base_sha,
    head_sha: headSha,
    objective: request.objective,
    responsibility_id: request.responsibility_id,
    instance_mode: request.instance_mode,
    evidence_scope: request.evidence_scope,
    return_and_stop: request.return_and_stop,
    role: request.role,
    agent_type: request.agent_type,
    task_name: request.task_name,
    fork_turns: request.fork_turns,
    context_mode: request.context_mode,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + request.ttl_seconds * 1000).toISOString(),
  };
  const bytes = prettyJsonBytes(intent);
  const target = path.join(intentDir, `${intentId}.json`);
  try {
    createExclusiveDurableFile({ root: repoRoot, parent: intentDir, target, body: bytes, hooks });
  } catch {
    return codexReviewerError("artifact-write-failed");
  }
  return {
    ok: true,
    intent_id: intentId,
    path: path.relative(repoRoot, target).split(path.sep).join("/"),
    digest_sha256: sha256(bytes),
    expires_at: intent.expires_at,
  };
}

function readCodexReviewerIntent({ repoRoot, intentDir, name, propagateNativeFaults = false }) {
  let bytes;
  try {
    ({ bytes } = readNoFollowFile({
      root: repoRoot,
      parent: intentDir,
      target: path.join(intentDir, name),
      maxBytes: CODEX_REVIEWER_STRUCTURED_MAX,
    }));
  } catch (error) {
    if (propagateNativeFaults && !isDurablePathError(error)) throw error;
    return codexReviewerError(error?.code === "target-oversize" ? "artifact-size-exceeded" : "intent-unreadable");
  }
  let intent;
  try {
    intent = parseJsonDuplicateAware(decodeStrictUtf8(bytes), "artifact-unparseable");
  } catch (error) {
    return codexReviewerError(error.code ?? "artifact-unparseable");
  }
  if (!hasExactOrderedKeys(intent, CODEX_REVIEWER_INTENT_KEYS) || intent.schema !== CODEX_REVIEWER_INTENT_SCHEMA) return codexReviewerError("artifact-unparseable");
  if (!prettyJsonBytes(intent).equals(bytes)) return codexReviewerError("artifact-noncanonical");
  const scalar = codexReviewerScalarProblem(intent);
  if (scalar) return codexReviewerError(scalar);
  if (`${intent.intent_id}.json` !== name) return codexReviewerError("identifier-invalid");
  return { ok: true, intent, bytes, digest_sha256: sha256(bytes) };
}

function codexReviewerTimeProblem(intent, nowMs) {
  const issued = Date.parse(intent.issued_at);
  const expires = Date.parse(intent.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)
    || new Date(issued).toISOString() !== intent.issued_at
    || new Date(expires).toISOString() !== intent.expires_at) return "timestamp-invalid";
  if (issued - nowMs > 30_000) return "intent-future-skew";
  if (expires <= issued || expires - issued > 600_000) return "intent-ttl-exceeded";
  return nowMs >= expires ? "intent-expired" : null;
}

function codexReviewerHostProjection(cwd, toolInput, hooks = {}) {
  const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"], hooks);
  const headSha = runGit(cwd, ["rev-parse", "HEAD"], hooks);
  if (!repoRoot || !headSha) return null;
  let canonicalCwd;
  let canonicalRepoRoot;
  try {
    canonicalCwd = realpathSync(cwd);
    canonicalRepoRoot = realpathSync(repoRoot);
  } catch {
    return null;
  }
  const changeId = resolveChangeIdFromCwd(canonicalRepoRoot);
  if (!changeId || canonicalCwd !== canonicalRepoRoot) return null;
  return {
    repoRoot: canonicalRepoRoot,
    changeId,
    canonical_worktree_sha256: sha256(Buffer.from(canonicalCwd, "utf8")),
    head_sha: headSha,
    agent_type: toolInput.agent_type,
    task_name: toolInput.task_name,
    fork_turns: toolInput.fork_turns,
    context_mode: toolInput.fork_turns === "none" ? "fresh" : "fork",
  };
}

function codexReviewerProjectionMatches(intent, observed) {
  return intent.canonical_worktree_sha256 === observed.canonical_worktree_sha256
    && intent.change_id === observed.changeId
    && intent.head_sha === observed.head_sha
    && intent.agent_type === observed.agent_type
    && intent.task_name === observed.task_name
    && intent.fork_turns === observed.fork_turns
    && intent.context_mode === observed.context_mode;
}

function sameCodexReviewerHostProjection(left, right) {
  return left.repoRoot === right.repoRoot
    && left.changeId === right.changeId
    && left.canonical_worktree_sha256 === right.canonical_worktree_sha256
    && left.head_sha === right.head_sha
    && left.agent_type === right.agent_type
    && left.task_name === right.task_name
    && left.fork_turns === right.fork_turns
    && left.context_mode === right.context_mode;
}

function revalidateSelectedCodexReviewerIntent({ toolInput, observed, intentDir, loaded, now, hooks = {} }) {
  // Revalidation binds the *selected* linked worktree, not the spawn-hook session cwd.
  const freshObserved = codexReviewerHostProjection(observed.repoRoot, toolInput, hooks);
  if (!freshObserved || !sameCodexReviewerHostProjection(observed, freshObserved)) {
    return codexReviewerError("intent-tuple-mismatch");
  }
  const fresh = readCodexReviewerIntent({
    repoRoot: freshObserved.repoRoot,
    intentDir,
    name: `${loaded.intent.intent_id}.json`,
  });
  if (!fresh.ok) return fresh;
  if (fresh.digest_sha256 !== loaded.digest_sha256 || !fresh.bytes.equals(loaded.bytes)) {
    return codexReviewerError("intent-tuple-mismatch");
  }
  const current = now();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
    return codexReviewerError("timestamp-invalid");
  }
  const timeProblem = codexReviewerTimeProblem(fresh.intent, current.getTime());
  if (timeProblem) return codexReviewerError(timeProblem);
  if (!codexReviewerProjectionMatches(fresh.intent, freshObserved)) {
    return codexReviewerError("intent-tuple-mismatch");
  }
  return { ok: true, observed: freshObserved, loaded: fresh, current };
}

function canonicalizeGitCommonDir(cwd, hooks = {}) {
  const commonDir = runGit(cwd, ["rev-parse", "--git-common-dir"], hooks);
  if (!commonDir) return null;
  try {
    return realpathSync(path.resolve(cwd, commonDir));
  } catch (error) {
    if (hooks.propagateNativeFaults) throw error;
    return null;
  }
}

/**
 * Enumerate the linked worktrees that carry a `.worktree/<change_id>` path
 * segment, without the change-directory filter (design D2.1 discovery split).
 * `discoverLinkedWorktreePaths` is exactly this enumeration plus the
 * change-dir filter, so the Codex prepared-intent scan keeps its historical
 * behavior. A listed path that cannot be canonicalized (a prunable worktree,
 * a removed directory) is excluded when `allowUnresolvablePaths` is set —
 * the declared-path selection may not bind a directory that does not exist —
 * and otherwise stays an incomplete-enumeration fault.
 */
// Post-PR Stop hook enumeration memo (fix-codex-reviewer-intent-candidate-cap D6). The handle is an opaque frozen
// object; its content lives only in this module-private WeakMap, so a caller cannot build or inspect one. Only a
// successful, deep-frozen member enumeration is stored, keyed by the unresolvable-path mode plus the canonical
// common-dir. The reuse never spans processes and never covers claim, seal, verify or native-fault-propagating calls.
const worktreeEnumerationMemos = new WeakMap();

export function createWorktreeEnumerationMemo() {
  const handle = Object.freeze({});
  worktreeEnumerationMemos.set(handle, new Map());
  return handle;
}

export function isWorktreeEnumerationMemo(value) {
  return value !== null && typeof value === "object" && worktreeEnumerationMemos.has(value);
}

// Any value other than a real handle (undefined = "no handle") is refused before any git call, whether or not the
// call would bypass the handle anyway.
function assertWorktreeEnumerationMemo(memo) {
  if (memo !== undefined && !isWorktreeEnumerationMemo(memo)) throw new Error("enumeration-memo-invalid");
}

function freezeEnumeration(result) {
  for (const entry of result.linked) Object.freeze(entry);
  Object.freeze(result.linked);
  return Object.freeze(result);
}

function enumerateLinkedWorktrees({ cwd, hooks = {}, allowUnresolvablePaths = false, memo }) {
  assertWorktreeEnumerationMemo(memo);
  const sourceCommonDir = canonicalizeGitCommonDir(cwd, hooks);
  if (!sourceCommonDir) return { ok: false, code: "reviewer-change-worktree-required" };
  // An injected git runner (test doubles) or native-fault propagation (seal/verify authority paths, which must be
  // repeated rather than cached) bypasses the handle: nothing is read from or written to it.
  const store = memo !== undefined && typeof hooks.git !== "function" && hooks.propagateNativeFaults !== true
    ? worktreeEnumerationMemos.get(memo)
    : undefined;
  const memoKey = `${allowUnresolvablePaths ? 1 : 0}\0${sourceCommonDir}`;
  if (store !== undefined && store.has(memoKey)) return store.get(memoKey);
  const result = scanLinkedWorktrees({ cwd, hooks, allowUnresolvablePaths, sourceCommonDir });
  // Only a complete enumeration is remembered; a failed one (transient list failure, stale worktree directory, the
  // worktree budget) is judged again by the next caller instead of being handed to every later marker.
  if (store !== undefined && result.ok === true) store.set(memoKey, freezeEnumeration(result));
  return result;
}

// Test-only named export (the `__testSnapshotFromGhData` precedent): returns the enumeration result, memo included.
export function __testEnumerateLinkedWorktrees(options) {
  return enumerateLinkedWorktrees(options);
}

function scanLinkedWorktrees({ cwd, hooks, allowUnresolvablePaths, sourceCommonDir }) {
  // Consume stdout with NULs intact; do not trim (would drop a required terminator).
  let raw;
  if (typeof hooks.git === "function") {
    raw = hooks.git(cwd, ["worktree", "list", "--porcelain", "-z"]);
  } else {
    const result = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (hooks.propagateNativeFaults && (result.error || result.status !== 0)) {
      throw result.error ?? new Error("unlisted Git result");
    }
    if (result.status !== 0) return { ok: false, code: "intent-scan-failed" };
    raw = String(result.stdout ?? "");
  }
  if (typeof raw !== "string") return { ok: false, code: "intent-scan-failed" };
  const parsed = parseWorktreePorcelainZ(raw);
  if (!parsed.ok) return { ok: false, code: "intent-scan-failed" };
  if (parsed.worktrees.length > CODEX_REVIEWER_WORKTREE_LIST_MAX) {
    return { ok: false, code: "intent-candidate-limit-exceeded" };
  }
  const linked = [];
  for (const entry of parsed.worktrees) {
    let canonicalPath;
    try {
      canonicalPath = realpathSync(entry.path);
    } catch (error) {
      if (hooks.propagateNativeFaults && !(allowUnresolvablePaths && error?.code === "ENOENT")) throw error;
      if (allowUnresolvablePaths) continue;
      return { ok: false, code: "intent-scan-failed" };
    }
    const candidateCommonDir = canonicalizeGitCommonDir(canonicalPath, hooks);
    if (!candidateCommonDir || candidateCommonDir !== sourceCommonDir) {
      // Distinct repo / foreign common-dir must not substitute for same-commit siblings.
      return { ok: false, code: "intent-scan-failed" };
    }
    const changeId = resolveChangeIdFromCwd(canonicalPath);
    if (!changeId) continue;
    linked.push({ repoRoot: canonicalPath, changeId });
  }
  return { ok: true, linked };
}

function discoverLinkedWorktreePaths(cwd, hooks = {}) {
  const enumerated = enumerateLinkedWorktrees({ cwd, hooks });
  if (!enumerated.ok) return enumerated;
  const linked = [];
  for (const entry of enumerated.linked) {
    const changeDir = resolveAdmissionChangeDir(entry.repoRoot, entry.changeId);
    if (changeDir === null) {
      // Proven absence may skip; existing-but-invalid / unreadable / containment
      // faults MUST fail the whole scan so partial enumeration cannot mint exact-one.
      if (admissionChangeEntryExists(entry.repoRoot, entry.changeId)) {
        return { ok: false, code: "intent-scan-failed" };
      }
      continue;
    }
    linked.push({ ...entry, changeDir });
  }
  return { ok: true, linked };
}

/**
 * Exact-one change-worktree binding (design D1／D2).
 *
 * Reuses `parseWorktreePorcelainZ` + common-dir discovery. `changeId` is a
 * **lookup key only** (CHANGE_ID_SHAPE) — never a path authority; selected
 * tree + head_sha come solely from discovery. MUST NOT read env / prompt /
 * notes / caller-supplied absolute paths as the selected tree.
 *
 * `requireChangeDir` (default `true`) keeps the historical candidate filter:
 * a candidate must resolve an active-or-archive change directory, a proven
 * absent one is skipped, and an existing-but-invalid one fails the scan. With
 * `false` (the declared-path resolver) the candidate is selected by its
 * `.worktree/<key>` path segment and `changeDir` may be `null` — the writer
 * still distinguishes proven absence (`change-dir-absent` advisory) from an
 * existing-but-invalid entry (`admission-records-dir-invalid`), so a null
 * change dir MUST NOT be read as a pass. Prunable／path-gone candidates are
 * excluded in this mode instead of failing the enumeration, and the excluded
 * entry keeps counting nowhere (never a partial exact-one).
 *
 * `branchChecks` (declared path only: `resolveAdmissionBinding` passes it as
 * `bindingPath === "declared"`) adds the post-check on the selected binding
 * root: a detached HEAD fails `binding-head-detached`, a protected base branch
 * fails `binding-branch-protected`, and a branch that does not follow the
 * `<prefix>/<change_id>` convention of the branch-naming SSOT surfaces the
 * closed non-blocking advisory `binding-branch-convention-advisory` with the
 * binding and `head_sha` unchanged. The cwd fast path keeps its existing
 * admission semantics and MUST NOT gain this post-check (design D2.3；
 * decisions D11): its revalidation is the exact-one selection plus the
 * toplevel containment check in `resolveAdmissionBinding`, so a cwd already
 * inside a live linked worktree keeps minting whether or not that worktree's
 * HEAD is detached or its branch is protected.
 *
 * `enumerationMemo` (optional; only the post-PR Stop hook's marker loop creates one, via
 * `createWorktreeEnumerationMemo`) lets calls in one process run share a single successfully
 * completed member enumeration. Anything else passed here throws `enumeration-memo-invalid`
 * before any git call; an injected `hooks.git` or `propagateNativeFaults` bypasses the handle.
 *
 * Fail codes (stable tokens, never absolute paths):
 * - `change-id-invalid` — caller changeId present but not CHANGE_ID_SHAPE
 * - `change-worktree-required` — zero candidates (or cwd common-dir unresolvable
 *   aliased from reviewer-change-worktree-required)
 * - `change-worktree-ambiguous` — ≥2 candidates after optional changeId filter
 * - `intent-scan-failed` — truncated／unparseable porcelain, foreign common-dir,
 *   or other scan faults (no partial exact-one mint)
 * - `intent-candidate-limit-exceeded` — porcelain enumeration over the worktree budget
 *   (`CODEX_REVIEWER_WORKTREE_LIST_MAX`, main checkout included)
 * - `git-head-unavailable` — binding tip HEAD not a 40-hex sha
 */
export function resolveExactOneChangeWorktreeBinding({ cwd, changeId, hooks = {}, requireChangeDir = true, branchChecks = false, propagateNativeFaults = false, enumerationMemo } = {}) {
  assertWorktreeEnumerationMemo(enumerationMemo);
  if (changeId !== undefined && changeId !== null && changeId !== "") {
    if (typeof changeId !== "string" || !CHANGE_ID_SHAPE.test(changeId)) {
      return { ok: false, code: "change-id-invalid" };
    }
  }
  const resolverHooks = propagateNativeFaults ? { ...hooks, propagateNativeFaults: true } : hooks;
  const enumerated = enumerateLinkedWorktrees({
    cwd,
    hooks: resolverHooks,
    allowUnresolvablePaths: requireChangeDir === false,
    memo: enumerationMemo,
  });
  if (!enumerated.ok) {
    if (enumerated.code === "reviewer-change-worktree-required") {
      return { ok: false, code: "change-worktree-required" };
    }
    return { ok: false, code: enumerated.code };
  }
  const eligible = [];
  for (const entry of enumerated.linked) {
    const changeDir = resolveAdmissionChangeDir(entry.repoRoot, entry.changeId, { propagateNativeFaults });
    if (changeDir === null) {
      if (requireChangeDir) {
        // Proven absence may skip; existing-but-invalid / unreadable / containment
        // faults MUST fail the whole scan so partial enumeration cannot mint exact-one.
        if (admissionChangeEntryExists(entry.repoRoot, entry.changeId, { propagateNativeFaults })) {
          return { ok: false, code: "intent-scan-failed" };
        }
        continue;
      }
      eligible.push({ ...entry, changeDir: null });
      continue;
    }
    eligible.push({ ...entry, changeDir });
  }
  const keyed = typeof changeId === "string" && CHANGE_ID_SHAPE.test(changeId)
    ? eligible.filter((entry) => entry.changeId === changeId)
    : eligible;
  if (keyed.length === 0) return { ok: false, code: "change-worktree-required" };
  if (keyed.length > 1) return { ok: false, code: "change-worktree-ambiguous" };
  const chosen = keyed[0];
  const headSha = runGit(chosen.repoRoot, ["rev-parse", "HEAD"], resolverHooks);
  if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) {
    return { ok: false, code: "git-head-unavailable" };
  }
  let branch = null;
  const advisories = [];
  if (branchChecks) {
    const symbolic = runGit(chosen.repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], resolverHooks);
    branch = typeof symbolic === "string" ? symbolic.trim() : "";
    if (branch.length === 0) {
      return { ok: false, code: "binding-head-detached", bindingRoot: chosen.repoRoot };
    }
    if (isProtectedBaseBranch(branch)) {
      return { ok: false, code: "binding-branch-protected", bindingRoot: chosen.repoRoot };
    }
    if (!matchesChangeBranchConvention(branch, chosen.changeId)) {
      advisories.push("binding-branch-convention-advisory");
    }
  }
  return {
    ok: true,
    repoRoot: chosen.repoRoot,
    changeId: chosen.changeId,
    headSha,
    changeDir: chosen.changeDir,
    branch,
    advisories,
  };
}

/**
 * One shared admission binding resolver (strengthen-admission-binding-portability
 * design D1／D3): the declared sources (A2／A1／A3, read order closed) plus the
 * same-common-dir exact-one `.worktree/<change_id>` selection decide the binding
 * and the `head_sha` a record is written against. The spawn cwd is only a fast
 * path: it MUST be revalidated by the same exact-one selection plus a toplevel
 * containment check, and a fast-path id that disagrees with a declared id fails
 * closed with `change-binding-mismatch` — neither side wins.
 *
 * Returns, on success, the binding root (`repoRoot`), the resolved `changeId`
 * (lookup key only, authority is the filesystem), `headSha`, the active-or-archive
 * `changeDir` (`null` when the bound change folder is proven absent), `branch`,
 * the `path` that resolved it (`cwd-fast` / `declared`) and any non-blocking
 * advisories. On failure: `{ ok: false, code }` plus `noDeclaration: true` when
 * no source resolved at all (the caller's role classification decides
 * block-versus-advisory) and `bindingRoot` when a candidate root was already
 * selected (it stays operator-visible, never persisted).
 */
export function resolveAdmissionBinding({ cwd, fields = {}, hooks = {} } = {}) {
  const cwdChangeId = resolveChangeIdFromCwd(cwd);
  const declared = resolveDeclaredChangeLookupKey(fields, { cwdChangeId });
  if (!declared.ok && declared.noDeclaration !== true) return { ok: false, code: declared.code };
  if (cwdChangeId !== null && declared.ok && declared.changeId !== cwdChangeId) {
    return { ok: false, code: "change-binding-mismatch" };
  }
  const key = declared.ok ? declared.changeId : cwdChangeId;
  if (key === null) return { ok: false, code: "change-worktree-required", noDeclaration: true };
  const bindingPath = cwdChangeId !== null ? "cwd-fast" : "declared";
  const binding = resolveExactOneChangeWorktreeBinding({
    cwd,
    changeId: key,
    hooks,
    requireChangeDir: false,
    branchChecks: bindingPath === "declared",
  });
  if (!binding.ok) {
    return {
      ok: false,
      code: binding.code,
      ...(typeof binding.bindingRoot === "string" ? { bindingRoot: binding.bindingRoot } : {}),
    };
  }
  if (bindingPath === "cwd-fast") {
    // D1.6 containment: the spawn cwd's git toplevel MUST equal the selected
    // binding root. A worktree subdirectory still resolves the same toplevel and
    // passes; a `.worktree/<id>` directory name that is not a live linked
    // worktree resolves the main checkout's toplevel and MUST fail closed
    // instead of writing the record into main (accident convergence).
    const toplevel = runGit(cwd, ["rev-parse", "--show-toplevel"], hooks);
    let canonicalTop = null;
    let canonicalRoot = null;
    try { canonicalTop = toplevel ? realpathSync(toplevel) : null; } catch { canonicalTop = null; }
    try { canonicalRoot = realpathSync(binding.repoRoot); } catch { canonicalRoot = null; }
    if (!canonicalTop || !canonicalRoot || canonicalTop !== canonicalRoot) {
      return { ok: false, code: "change-worktree-required", bindingRoot: binding.repoRoot };
    }
  }
  return {
    ok: true,
    repoRoot: binding.repoRoot,
    changeId: binding.changeId,
    headSha: binding.headSha,
    changeDir: binding.changeDir,
    branch: binding.branch,
    path: bindingPath,
    advisories: binding.advisories,
  };
}

/**
 * `<prefix>/<change_id>` convention check against the branch-naming SSOT
 * prefix set (feature／bugfix／chore／hotfix／rules). A mismatch is a
 * **non-blocking** advisory: lawful lanes (hotfix, rules, release) are
 * reported rather than refused, and the binding／mint／head_sha stay unchanged.
 */
function matchesChangeBranchConvention(branch, changeId) {
  const parsed = parseBranchName(branch);
  return parsed.ok === true && parsed.body === changeId;
}

/** Closed prefix set stripped from responsibility_id before CHANGE_ID_SHAPE remainder check. */
const RESPONSIBILITY_CHANGE_ID_PREFIXES = Object.freeze([
  "implement-",
  "review-",
  "verify-",
  "remediate-",
]);

/**
 * Derive the **trusted** changeId lookup key from `responsibility_id`.
 * Only a closed role prefix whose remainder matches CHANGE_ID_SHAPE is
 * trusted. Whole-id / bare CHANGE_ID_SHAPE values (e.g. `primary-review`)
 * are **not** trusted — they collide with ordinary duty names and with
 * accidental `.worktree/<same-slug>` trees (class-one natural false-positive).
 * Returns null when no trusted changeId can be derived.
 */
export function extractTrustedChangeIdFromResponsibilityId(responsibilityId) {
  if (typeof responsibilityId !== "string" || !responsibilityId) return null;
  for (const prefix of RESPONSIBILITY_CHANGE_ID_PREFIXES) {
    if (!responsibilityId.startsWith(prefix)) continue;
    const remainder = responsibilityId.slice(prefix.length);
    if (CHANGE_ID_SHAPE.test(remainder)) return remainder;
  }
  return null;
}

/**
 * A3 segment extractor shared by the two A3 readers (design D1.1). Each
 * carrier is scanned on its own — never joined into one string — so a segment
 * can neither swallow the following carrier nor a newline, and the candidate is
 * the maximal run of segment characters ending at a path separator, a
 * whitespace/backtick boundary, or the carrier end (cross-model CM-2: the
 * joined-buffer regex anchored `$` on the join and `[^/\\]+` swallowed
 * newlines and backticks, dropping the id or missing ambiguity). `archive` is
 * never a change id.
 */
function declaredScopeIds(fields) {
  const patterns = [
    /\.worktree[/\\]([^/\\\s`]+)/g,
    /openspec[/\\]changes[/\\]([^/\\\s`]+)/g,
  ];
  const declared = new Set();
  for (const carrier of [fields?.evidence_scope, fields?.return_and_stop]) {
    if (typeof carrier !== "string" || carrier.length === 0) continue;
    for (const pattern of patterns) {
      for (const match of carrier.matchAll(pattern)) {
        const candidate = match[1];
        if (candidate === "archive") continue;
        if (CHANGE_ID_SHAPE.test(candidate)) declared.add(candidate);
      }
    }
  }
  return declared;
}

/**
 * Extract a verified changeId **lookup key** from host-visible admission
 * fields (design-gate I1 / D2).
 *
 * SUPERSEDED (strengthen-admission-binding-portability design D1): the
 * declared-path resolver is `resolveDeclaredChangeLookupKey`, whose A2／A1／A3
 * read order is closed and whose consistency compares only read sources. This
 * function keeps the historical corroboration semantics (A1 is the only
 * trusted key, A3 is corroboration and never sufficient alone, a single
 * disagreeing A3 id is `change-id-mismatch`) and has no production caller any
 * more — new code MUST use `resolveDeclaredChangeLookupKey`.
 *
 * `responsibility_id` is the **trusted** lookup key (closed role-prefix strip
 * only — no whole-id fallback). `evidence_scope`／`return_and_stop` segment
 * tokens (`.worktree/<id>` or `openspec/changes/<id>`, skipping `archive`)
 * are **corroboration only** — never path authority and never sufficient alone.
 *
 * Returns:
 * - `{ ok: true, changeId }` when trusted is present and declared scope ids
 *   are empty or exactly the trusted id
 * - `{ ok: false, code: "change-worktree-required" }` when no trusted
 *   responsibility_id changeId (MUST NOT succeed on scope-only)
 * - `{ ok: false, code: "change-worktree-ambiguous" }` when ≥2 distinct
 *   declared scope ids
 * - `{ ok: false, code: "change-id-mismatch" }` when exactly one declared id
 *   disagrees with trusted
 */
export function extractChangeIdLookupKeyFromAdmissionFields(fields = {}) {
  const trusted = extractTrustedChangeIdFromResponsibilityId(fields.responsibility_id);
  const declared = declaredScopeIds(fields);
  if (!trusted) {
    return { ok: false, code: "change-worktree-required" };
  }
  if (declared.size === 0) {
    return { ok: true, changeId: trusted };
  }
  if (declared.size === 1 && declared.has(trusted)) {
    return { ok: true, changeId: trusted };
  }
  if (declared.size > 1) {
    return { ok: false, code: "change-worktree-ambiguous" };
  }
  return { ok: false, code: "change-id-mismatch" };
}

/**
 * Declared change lookup key (strengthen-admission-binding-portability design
 * D1.1): a closed read order over the declaration sources.
 *
 * 1. **A2** `fields.change_id` present is the authoritative key: a value
 *    outside the `change_id` grammar fails closed with `change-id-invalid`, a
 *    derivable **A1** trusted `responsibility_id` prefix that disagrees with A2
 *    fails closed with `admission-binding-inconsistent`, and A3 goes unread.
 * 2. A2 absent and A1 derivable → A1 is the key and A3 goes unread.
 * 3. Both absent and the spawn cwd resolved no fast-path id
 *    (`cwdChangeId === null`) → **A3** is the sole source: the bounded
 *    `evidence_scope`／`return_and_stop` `.worktree/<id>`／`openspec/changes/<id>`
 *    segments (excluding `archive`, each carrier scanned separately with the
 *    segment boundary at a path separator, a whitespace/backtick, or the
 *    carrier end) must yield exactly one distinct id; two or
 *    more fail closed with `change-worktree-ambiguous`, zero is equivalent to no
 *    declaration (`change-worktree-required` + `noDeclaration`, resolved by the
 *    caller's role classification). When a cwd id resolves, only A2／A1 are
 *    compared against it and A3 MUST NOT be read.
 *
 * The declared id is a **lookup key only** — never path authority, never
 * compliance evidence; the filesystem exact-one selection decides the binding.
 */
export function resolveDeclaredChangeLookupKey(fields = {}, { cwdChangeId = null } = {}) {
  const a2 = fields?.change_id;
  const a1 = extractTrustedChangeIdFromResponsibilityId(fields?.responsibility_id);
  if (a2 !== undefined) {
    if (typeof a2 !== "string" || !CHANGE_ID_SHAPE.test(a2)) return { ok: false, code: "change-id-invalid" };
    if (a1 !== null && a1 !== a2) return { ok: false, code: "admission-binding-inconsistent" };
    return { ok: true, changeId: a2, source: "change_id" };
  }
  if (a1 !== null) return { ok: true, changeId: a1, source: "responsibility_id" };
  if (cwdChangeId !== null) return { ok: false, code: "change-worktree-required", noDeclaration: true };
  const declared = declaredScopeIds(fields);
  if (declared.size > 1) return { ok: false, code: "change-worktree-ambiguous" };
  if (declared.size === 0) return { ok: false, code: "change-worktree-required", noDeclaration: true };
  return { ok: true, changeId: [...declared][0], source: "evidence_scope" };
}

function codexReviewerIntentClaimState(intentDir, intentId) {
  const claimDir = path.join(intentDir, `${intentId}.claim`);
  try {
    const stat = lstatSync(claimDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { ok: false, code: "intent-unreadable" };
    }
    return { ok: true, consumed: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, consumed: false };
    return { ok: false, code: "intent-scan-failed" };
  }
}

// Stage one of the prepared-intent scan: list one intent directory without reading any file in it.
function listCodexReviewerIntentDir(intentDir, hooks = {}) {
  try {
    const entries = typeof hooks.readdirIntentDir === "function"
      ? hooks.readdirIntentDir(intentDir)
      : readdirSync(intentDir, { withFileTypes: true });
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, code: error?.code === "ENOENT" ? "intent-missing" : "intent-scan-failed" };
  }
}

// Stage two: full validation of the `.json` candidates in the very listing that was counted (never a second readdir).
function evaluateCodexReviewerIntentEntries({ observed, intentDir, entries, nowMs }) {
  const candidates = entries.filter((entry) => entry.name.endsWith(".json"));
  const live = [];
  const temporal = [];
  let projectionMismatch = false;
  let consumedMatch = 0;
  for (const candidate of candidates) {
    if (!candidate.isFile()) return { ok: false, code: "intent-unreadable" };
    const intentId = candidate.name.slice(0, -".json".length);
    if (!UUID_V4_SHAPE.test(intentId)) return { ok: false, code: "identifier-invalid" };
    const claimState = codexReviewerIntentClaimState(intentDir, intentId);
    if (!claimState.ok) return claimState;
    const loaded = readCodexReviewerIntent({ repoRoot: observed.repoRoot, intentDir, name: candidate.name });
    if (!loaded.ok) return loaded;
    const timeProblem = codexReviewerTimeProblem(loaded.intent, nowMs);
    if (timeProblem) { temporal.push(timeProblem); continue; }
    if (!codexReviewerProjectionMatches(loaded.intent, observed)) { projectionMismatch = true; continue; }
    if (claimState.consumed) {
      consumedMatch += 1;
      continue;
    }
    live.push(loaded);
  }
  return { ok: true, live, temporal, projectionMismatch, consumedMatch, entryCount: entries.length };
}

function resolvePreparedCodexReviewerSelection({ cwd, toolInput, now, hooks = {} }) {
  const current = now();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
    return codexReviewerError("timestamp-invalid");
  }
  const nowMs = current.getTime();
  const fastObserved = codexReviewerHostProjection(cwd, toolInput, hooks);
  if (fastObserved) {
    const changeDir = resolveAdmissionChangeDir(fastObserved.repoRoot, fastObserved.changeId);
    if (changeDir === null) {
      // Existing-but-invalid / unreadable local entry stays fail-closed.
      // Proven local absence falls through to common-dir discovery.
      if (admissionChangeEntryExists(fastObserved.repoRoot, fastObserved.changeId)) {
        return codexReviewerError("artifact-parent-invalid");
      }
    } else {
      const intentDir = path.join(changeDir, "admission-records", "codex-reviewer-intents");
      const listed = listCodexReviewerIntentDir(intentDir, hooks);
      // The local directory obeys the same entry budget and fails closed over it: it does NOT fall back to global
      // discovery, which would only widen the scan.
      const scanned = listed.ok && listed.entries.length > CODEX_REVIEWER_INTENT_ENTRY_MAX
        ? { ok: false, code: "intent-entry-budget-exhausted" }
        : listed.ok
          ? evaluateCodexReviewerIntentEntries({ observed: fastObserved, intentDir, entries: listed.entries, nowMs })
          : listed;
      if (!scanned.ok) {
        // Missing local intent dir is "no live local match" → fall through to
        // common-dir discovery (sibling exact-one). Other scan faults stay closed.
        if (scanned.code !== "intent-missing") return codexReviewerError(scanned.code);
      } else if (scanned.live.length > 1) {
        return codexReviewerError("intent-ambiguous");
      } else if (scanned.live.length === 1) {
        return {
          ok: true,
          observed: fastObserved,
          changeDir,
          intentDir,
          loaded: scanned.live[0],
          current,
        };
      }
      // live.length === 0 (including local consumed-only): fall through to
      // common-dir discovery so a sibling's fresh exact-one intent can admit.
      // intent-consumed is reserved for discovery-wide "no live match remains".
    }
  }

  const discovered = discoverLinkedWorktreePaths(cwd, hooks);
  if (!discovered.ok) return codexReviewerError(discovered.code);
  if (discovered.linked.length === 0) return codexReviewerError("reviewer-change-worktree-required");

  // Stage one: list every candidate's intent directory and sum the entries. Nothing is projected (no git call) and no
  // intent file is read until the whole listing is inside the entry budget.
  const listings = [];
  let totalEntries = 0;
  for (const candidate of discovered.linked) {
    const intentDir = path.join(candidate.changeDir, "admission-records", "codex-reviewer-intents");
    const listed = listCodexReviewerIntentDir(intentDir, hooks);
    if (!listed.ok) {
      if (listed.code === "intent-missing") continue;
      return codexReviewerError(listed.code);
    }
    totalEntries += listed.entries.length;
    if (totalEntries > CODEX_REVIEWER_INTENT_ENTRY_MAX) {
      return codexReviewerError("intent-entry-budget-exhausted");
    }
    listings.push({ candidate, intentDir, entries: listed.entries });
  }
  const sawIntentDir = listings.length > 0;

  // Stage two: host projection and full validation over the same listings.
  const liveAcross = [];
  const temporal = [];
  let projectionMismatch = false;
  let consumedMatch = 0;
  for (const { candidate, intentDir, entries } of listings) {
    const observed = codexReviewerHostProjection(candidate.repoRoot, toolInput, hooks);
    if (!observed) return codexReviewerError("intent-scan-failed");
    const scanned = evaluateCodexReviewerIntentEntries({ observed, intentDir, entries, nowMs });
    if (!scanned.ok) return codexReviewerError(scanned.code);
    if (scanned.projectionMismatch) projectionMismatch = true;
    temporal.push(...scanned.temporal);
    consumedMatch += scanned.consumedMatch;
    for (const loaded of scanned.live) {
      liveAcross.push({
        observed,
        changeDir: candidate.changeDir,
        intentDir,
        loaded,
      });
    }
  }
  if (liveAcross.length === 0) {
    if (consumedMatch > 0) return codexReviewerError("intent-consumed");
    if (!sawIntentDir) return codexReviewerError("intent-missing");
    return codexReviewerError(projectionMismatch ? "intent-tuple-mismatch" : (temporal[0] ?? "intent-missing"));
  }
  if (liveAcross.length > 1) return codexReviewerError("intent-ambiguous");
  return {
    ok: true,
    observed: liveAcross[0].observed,
    changeDir: liveAcross[0].changeDir,
    intentDir: liveAcross[0].intentDir,
    loaded: liveAcross[0].loaded,
    current,
  };
}

function codexReviewerProvenance() {
  return {
    derived: ["schema", "record_id", "intent_sha256", "admitted_at", "role_binding"],
    "intent-declared": ["intent_id"],
    "host-observed": ["host"],
    "host-matched": ["change_id", "canonical_worktree_sha256", "head_sha", "role", "agent_type", "task_name", "fork_turns", "context_mode"],
    cooperative: ["base_sha", "objective", "responsibility_id", "instance_mode", "evidence_scope", "return_and_stop"],
  };
}

function claimCodexReviewerIntent({ repoRoot, intentDir, loaded, recordId, claimedAt, hooks }) {
  const claimDir = path.join(intentDir, `${loaded.intent.intent_id}.claim`);
  try {
    mkdirSync(claimDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    return codexReviewerError(error?.code === "EEXIST" ? "intent-consumed" : "intent-claim-write-failed");
  }
  const { fsyncDir = fsyncDirectory } = hooks;
  try {
    fsyncDir(intentDir);
  } catch {
    return codexReviewerError("intent-claim-write-failed");
  }
  const claim = {
    schema: CODEX_REVIEWER_INTENT_CLAIM_SCHEMA,
    intent_id: loaded.intent.intent_id,
    intent_sha256: loaded.digest_sha256,
    record_id: recordId,
    claimed_at: claimedAt.toISOString(),
  };
  try {
    createExclusiveDurableFile({
      root: repoRoot,
      parent: claimDir,
      target: path.join(claimDir, "consumed.json"),
      body: prettyJsonBytes(claim),
      hooks,
    });
  } catch {
    return codexReviewerError("intent-claim-write-failed");
  }
  return { ok: true, claim };
}

export function admitPreparedCodexReviewer({ cwd, toolInput, now = () => new Date(), uuid = randomUUID, hooks = {} }) {
  const selected = resolvePreparedCodexReviewerSelection({ cwd, toolInput, now, hooks });
  if (!selected.ok) return selected;
  const { observed, changeDir, intentDir, loaded } = selected;
  const admissionDir = path.join(changeDir, "admission-records");
  const recordId = uuid();
  if (!UUID_V4_SHAPE.test(recordId)) return codexReviewerError("identifier-invalid");
  const preclaim = revalidateSelectedCodexReviewerIntent({
    toolInput,
    observed,
    intentDir,
    loaded,
    now,
    hooks,
  });
  if (!preclaim.ok) return preclaim;
  const claim = claimCodexReviewerIntent({
    repoRoot: preclaim.observed.repoRoot,
    intentDir,
    loaded: preclaim.loaded,
    recordId,
    claimedAt: preclaim.current,
    hooks,
  });
  if (!claim.ok) return claim;
  hooks.afterClaim?.();
  const postclaim = revalidateSelectedCodexReviewerIntent({
    toolInput,
    observed: preclaim.observed,
    intentDir,
    loaded: preclaim.loaded,
    now,
    hooks,
  });
  if (!postclaim.ok) return postclaim;
  const intent = postclaim.loaded.intent;
  const record = {
    schema: CODEX_REVIEWER_ADMISSION_SCHEMA,
    record_id: recordId,
    intent_id: intent.intent_id,
    intent_sha256: postclaim.loaded.digest_sha256,
    change_id: postclaim.observed.changeId,
    host: "codex",
    admitted_at: preclaim.current.toISOString(),
    canonical_worktree_sha256: postclaim.observed.canonical_worktree_sha256,
    base_sha: intent.base_sha,
    head_sha: postclaim.observed.head_sha,
    objective: intent.objective,
    responsibility_id: intent.responsibility_id,
    instance_mode: intent.instance_mode,
    evidence_scope: intent.evidence_scope,
    return_and_stop: intent.return_and_stop,
    role: "dp-reviewer",
    agent_type: postclaim.observed.agent_type,
    task_name: postclaim.observed.task_name,
    fork_turns: postclaim.observed.fork_turns,
    context_mode: postclaim.observed.context_mode,
    role_binding: "host-verified",
    provenance: codexReviewerProvenance(),
  };
  const bytes = prettyJsonBytes(record);
  const target = path.join(admissionDir, `${recordId}.json`);
  // Non-authoritative staging + no-replace hardlink publish, then a post-fsync
  // `.json.ok` commit marker. Verifier / recover accept authority only when both
  // the final record and matching `.json.ok` exist, so any pre-commit survivor
  // without the marker remains unverifiable even if unlink/truncate/rename fail.
  const staging = path.join(admissionDir, `${recordId}.json.publishing`);
  const ready = path.join(admissionDir, `${recordId}.json.ok`);
  const digest = sha256(bytes);
  const unlinkAdmissionTarget = hooks.unlinkAdmissionTarget ?? unlinkSync;
  const linkAdmissionTarget = hooks.linkAdmissionTarget ?? linkSync;
  const invalidateOwnedAdmissionTarget = hooks.invalidateOwnedAdmissionTarget ?? ((candidate) => {
    try {
      truncateSync(candidate, 0);
      return;
    } catch { /* continue */ }
    try {
      renameSync(candidate, staging);
    } catch { /* best effort */ }
  });
  const committedAdmission = () => ({
    ok: true,
    record_id: recordId,
    digest,
    intent_id: intent.intent_id,
    record,
  });
  const scrubOwnedPublication = (owned) => {
    for (const candidate of [ready, target, staging]) {
      try {
        if (candidate === ready) {
          try { unlinkAdmissionTarget(ready); } catch { /* marker absence keeps authority unverifiable */ }
          continue;
        }
        const onDisk = lstatSync(candidate);
        if (!owned || onDisk.dev !== owned.dev || onDisk.ino !== owned.ino) continue;
        try {
          unlinkAdmissionTarget(candidate);
        } catch {
          if (candidate === target) invalidateOwnedAdmissionTarget(candidate);
        }
      } catch {
        /* absent is fine */
      }
    }
    try { unlinkAdmissionTarget(staging); } catch { /* staging leftover is non-authoritative */ }
    try { unlinkAdmissionTarget(ready); } catch { /* marker leftover without success path is scrubbed best-effort */ }
  };
  let ownedInode = null;
  try {
    createExclusiveDurableFile({
      root: postclaim.observed.repoRoot,
      parent: admissionDir,
      target: staging,
      body: bytes,
      hooks,
    });
    const stagingStat = lstatSync(staging);
    if (!stagingStat.isFile()) {
      const error = new Error("staging-not-regular-file");
      error.code = "target-not-regular-file";
      throw error;
    }
    ownedInode = { dev: stagingStat.dev, ino: stagingStat.ino };
    linkAdmissionTarget(staging, target);
    const published = lstatSync(target);
    if (!published.isFile() || published.dev !== ownedInode.dev || published.ino !== ownedInode.ino) {
      const error = new Error("published-inode-mismatch");
      error.code = "same-inode-proof-failed";
      throw error;
    }
    try { unlinkAdmissionTarget(staging); } catch { /* hardlink at target remains until commit marker */ }
    // Terminal durability for the authoritative directory entry, then the
    // verifier-visible commit marker. Either failure stays pre-commit.
    (hooks.fsyncDir ?? fsyncDirectory)(admissionDir);
    createExclusiveDurableFile({
      root: postclaim.observed.repoRoot,
      parent: admissionDir,
      target: ready,
      body: `${digest}\n`,
      hooks,
    });
  } catch {
    scrubOwnedPublication(ownedInode);
    return codexReviewerError("admission-record-write-failed");
  }
  try {
    hooks.beforeAdmissionReadback?.({ target });
  } catch {
    // Test/diagnostic observation faults after the durable publication commit
    // point must not create a block result beside a valid recoverable record.
    // Continue into the real no-follow read so positive absence/mutation still
    // fails closed below.
  }
  const readAdmissionRecordAfterCommit = hooks.readAdmissionRecord ?? readNoFollowFile;
  let readback;
  try {
    ({ bytes: readback } = readAdmissionRecordAfterCommit({ root: postclaim.observed.repoRoot, parent: admissionDir, target, maxBytes: CODEX_REVIEWER_STRUCTURED_MAX }));
  } catch (error) {
    return ADMISSION_READBACK_INVALIDATING_CODES.has(error?.code)
      ? codexReviewerError("admission-record-readback-mismatch")
      : committedAdmission();
  }
  if (!readback.equals(bytes)) return codexReviewerError("admission-record-readback-mismatch");
  return committedAdmission();
}

export function validateAdmissionRecordV2(record) {
  if (!hasExactOrderedKeys(record, CODEX_REVIEWER_ADMISSION_KEYS) || record.schema !== CODEX_REVIEWER_ADMISSION_SCHEMA) return codexReviewerError("artifact-unparseable");
  const scalarProblem = codexReviewerScalarProblem(record);
  if (scalarProblem) return codexReviewerError(scalarProblem);
  if (!UUID_V4_SHAPE.test(record.record_id) || !CODEX_REVIEWER_DIGEST.test(record.intent_sha256)
    || record.host !== "codex" || record.role_binding !== "host-verified") return codexReviewerError("artifact-unparseable");
  const expected = codexReviewerProvenance();
  if (JSON.stringify(record.provenance) !== JSON.stringify(expected)) return codexReviewerError("artifact-unparseable");
  const covered = Object.values(record.provenance).flat();
  const top = CODEX_REVIEWER_ADMISSION_KEYS.filter((key) => key !== "provenance");
  if (covered.length !== top.length || new Set(covered).size !== top.length || top.some((key) => !covered.includes(key))) {
    return codexReviewerError("artifact-unparseable");
  }
  return { ok: true };
}

export function verifyCodexReviewerAdmissionAuthority({ repoRoot, changeId, recordId, propagateNativeFaults = false }) {
  const admission = readAdmissionRecord({ repoRoot, changeId, recordId, propagateNativeFaults });
  if (!admission.ok || admission.record.schema !== CODEX_REVIEWER_ADMISSION_SCHEMA) return codexReviewerError("authority-binding-mismatch");
  const changeDir = resolveAdmissionChangeDir(repoRoot, changeId, { propagateNativeFaults });
  if (changeDir === null) return codexReviewerError("authority-binding-mismatch");
  const admissionDir = path.join(changeDir, "admission-records");
  try {
    const { bytes: readyBytes } = readNoFollowFile({
      root: repoRoot,
      parent: admissionDir,
      target: path.join(admissionDir, `${recordId}.json.ok`),
      maxBytes: 128,
    });
    if (!readyBytes.equals(Buffer.from(`${admission.digest}\n`, "utf8"))) {
      return codexReviewerError("authority-binding-mismatch");
    }
  } catch (error) {
    if (propagateNativeFaults && !isDurablePathError(error)) throw error;
    return codexReviewerError("authority-binding-mismatch");
  }
  const intentDir = path.join(admissionDir, "codex-reviewer-intents");
  const loadedIntent = readCodexReviewerIntent({
    repoRoot,
    intentDir,
    name: `${admission.record.intent_id}.json`,
    propagateNativeFaults,
  });
  if (!loadedIntent.ok || loadedIntent.digest_sha256 !== admission.record.intent_sha256) return codexReviewerError("authority-binding-mismatch");
  const intent = loadedIntent.intent;
  const record = admission.record;
  for (const key of ["change_id", "canonical_worktree_sha256", "base_sha", "head_sha", "objective", "responsibility_id", "instance_mode", "evidence_scope", "return_and_stop", "role", "agent_type", "task_name", "fork_turns", "context_mode"]) {
    if (record[key] !== intent[key]) return codexReviewerError("authority-binding-mismatch");
  }
  const issuedAt = Date.parse(intent.issued_at);
  const expiresAt = Date.parse(intent.expires_at);
  const admittedAt = Date.parse(record.admitted_at);
  if (![issuedAt, expiresAt, admittedAt].every(Number.isFinite)
    || new Date(issuedAt).toISOString() !== intent.issued_at
    || new Date(expiresAt).toISOString() !== intent.expires_at
    || new Date(admittedAt).toISOString() !== record.admitted_at
    || issuedAt > admittedAt || admittedAt >= expiresAt || expiresAt <= issuedAt || expiresAt - issuedAt > 600_000) {
    return codexReviewerError("authority-binding-mismatch");
  }
  const claimDir = path.join(intentDir, `${intent.intent_id}.claim`);
  let claimBytes;
  try {
    ({ bytes: claimBytes } = readNoFollowFile({ root: repoRoot, parent: claimDir, target: path.join(claimDir, "consumed.json"), maxBytes: CLAIM_MAX_BYTES }));
  } catch (error) {
    if (propagateNativeFaults && !isDurablePathError(error)) throw error;
    return codexReviewerError("authority-binding-mismatch");
  }
  let claim;
  try { claim = parseJsonDuplicateAware(decodeStrictUtf8(claimBytes)); } catch { return codexReviewerError("authority-binding-mismatch"); }
  if (!hasExactOrderedKeys(claim, CODEX_REVIEWER_INTENT_CLAIM_KEYS) || claim.schema !== CODEX_REVIEWER_INTENT_CLAIM_SCHEMA
    || !prettyJsonBytes(claim).equals(claimBytes) || claim.intent_id !== intent.intent_id
    || claim.intent_sha256 !== loadedIntent.digest_sha256 || claim.record_id !== recordId
    || claim.claimed_at !== record.admitted_at) return codexReviewerError("authority-binding-mismatch");
  return {
    ok: true,
    admission,
    intent,
    intent_ref: { intent_id: intent.intent_id, digest_sha256: loadedIntent.digest_sha256 },
    admission_ref: { record_id: recordId, digest_sha256: admission.digest },
  };
}

export function recoverCodexReviewerAdmission({ cwd, request }) {
  const problem = codexReviewerRecoveryRequestProblem(request);
  if (problem) return codexReviewerError(problem);
  const changeId = resolveChangeIdFromCwd(cwd);
  const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
  const headSha = git(cwd, ["rev-parse", "HEAD"]);
  if (!changeId || !repoRoot || !headSha || request.change_id !== changeId) return codexReviewerError("intent-tuple-mismatch");
  const changeDir = resolveAdmissionChangeDir(repoRoot, changeId);
  if (changeDir === null) return codexReviewerError("authority-binding-mismatch");
  const intentDir = path.join(changeDir, "admission-records", "codex-reviewer-intents");
  const loadedIntent = readCodexReviewerIntent({ repoRoot, intentDir, name: `${request.intent_id}.json` });
  if (!loadedIntent.ok || loadedIntent.digest_sha256 !== request.intent_sha256) return codexReviewerError("authority-binding-mismatch");
  const intent = loadedIntent.intent;
  if (intent.change_id !== changeId || intent.head_sha !== headSha
    || intent.canonical_worktree_sha256 !== sha256(Buffer.from(realpathSync(cwd), "utf8"))) {
    return codexReviewerError("intent-tuple-mismatch");
  }
  const claimDir = path.join(intentDir, `${intent.intent_id}.claim`);
  let claimBytes;
  try {
    ({ bytes: claimBytes } = readNoFollowFile({
      root: repoRoot,
      parent: claimDir,
      target: path.join(claimDir, "consumed.json"),
      maxBytes: CLAIM_MAX_BYTES,
    }));
  } catch { return codexReviewerError("authority-binding-mismatch"); }
  let claim;
  try { claim = parseJsonDuplicateAware(decodeStrictUtf8(claimBytes)); } catch { return codexReviewerError("authority-binding-mismatch"); }
  if (!hasExactOrderedKeys(claim, CODEX_REVIEWER_INTENT_CLAIM_KEYS)
    || claim.schema !== CODEX_REVIEWER_INTENT_CLAIM_SCHEMA
    || !prettyJsonBytes(claim).equals(claimBytes)
    || claim.intent_id !== intent.intent_id
    || claim.intent_sha256 !== loadedIntent.digest_sha256) return codexReviewerError("authority-binding-mismatch");
  const verified = verifyCodexReviewerAdmissionAuthority({ repoRoot, changeId, recordId: claim.record_id });
  if (!verified.ok) return codexReviewerError("authority-binding-mismatch");
  const admissionPath = path.join(changeDir, "admission-records", `${claim.record_id}.json`);
  return {
    ok: true,
    intent_id: intent.intent_id,
    record_id: claim.record_id,
    path: path.relative(repoRoot, admissionPath).split(path.sep).join("/"),
    digest: verified.admission.digest,
    handoff: admissionHandoff({ record_id: claim.record_id, digest: verified.admission.digest }),
  };
}

export function admissionHandoff({ record_id, digest }) {
  return `admission_record: ${record_id} sha256=${digest}`;
}
