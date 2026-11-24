/**
 * Half-state single-use override: exact-once claim protocol
 * (strengthen-subagent-delegation-strategy design D12 + D15).
 *
 * Carrier: `openspec/changes/<change_id>/override-ledger/` (worktree-local,
 * gitignored). Tracking the ledger while its `.claim/` consumption proof stays
 * untracked would let a consumed override read as `issued` again on a fresh
 * clone, so neither side is tracked: a clone sees no override at all and the
 * user must re-issue. The audit trail lives in the PR body and decisions.
 * `openspec archive` moves the ledger with the change folder, so the read side
 * (read / status / consumed-claim proof) resolves the change folder the same
 * way admission records do (`resolveAdmissionChangeDir`: active folder, else
 * the archived one); issue and claim write only into the active folder.
 * - issue:   one file per override `<override_id>.json` (D15 (B) create path;
 *            no shared JSON, no read-modify-write).
 * - claim:   `mkdirSync(<override_id>.claim/, { recursive: false })` is the
 *            exclusivity primitive — at most one caller succeeds; the winner
 *            then durably writes `claim/consumed.json = { dispatch_id, ... }`.
 *            ANY `EEXIST` is refused (no idempotent-retry branch: two callers
 *            at the same head compute the same deterministic dispatch_id, so
 *            the consumed dispatch_id can never prove single authorization).
 * - states:  issued -> claimed-incomplete -> consumed; the two non-issued
 *            states never authorize again; a crash after the claim consumes
 *            the override (the user issues a new one). Claim directories are
 *            audit trail: never cleaned, taken over, or rolled back.
 * Threat model is the narrow D15 (D) one: traversal, stray symlinks, parent
 * swap between check and open — not a same-uid active attacker.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  CHANGE_ID_SHAPE,
  UUID_V4_SHAPE,
  createExclusiveDurableFile,
  fsyncDirectory,
  readNoFollowFile,
  verifyParentPath,
} from "./durable-fs.mjs";
import { resolveAdmissionChangeDir } from "../hooks/lib/admission-record.mjs";

export const HALF_STATE_OVERRIDE_SCHEMA = "devpro.half-state-override/v1";
export const HALF_STATE_OVERRIDE_CLAIM_SCHEMA = "devpro.half-state-override-claim/v1";
export const HALF_STATE_OVERRIDE_SCOPE = "review-dispatch";
export const BUDGET_STATES = Object.freeze(["below-half", "at-or-above-half", "exhausted", "unavailable"]);
export const OVERRIDE_RECORD_KEYS = Object.freeze(["schema", "override_id", "responsibility_id", "issued_by", "issued_at", "scope", "reason"]);

const RESPONSIBILITY_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DISPATCH_ID_SHAPE = /^[0-9a-f]{64}$/;
const REASON_MAX = 500;
const RECORD_MAX_BYTES = 64 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function changeDirOf(repoRoot, changeId) {
  return path.join(repoRoot, "openspec", "changes", changeId);
}

function ledgerDirOf(repoRoot, changeId) {
  return path.join(changeDirOf(repoRoot, changeId), "override-ledger");
}

// Read side only: an archived change still proves the overrides it consumed
// (pre-PR seal-final runs after archive). null when no folder resolves.
function readLedgerDirOf(repoRoot, changeId) {
  const changeDir = resolveAdmissionChangeDir(repoRoot, changeId);
  return changeDir === null ? null : path.join(changeDir, "override-ledger");
}

function plainDirectory(target) {
  try {
    const stat = lstatSync(target);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

// I-01 (PR #2473 second cross-model round): containment was anchored at the
// change directory, so `openspec/` and `openspec/changes/` were never lstat'ed
// and a symlink at either component escaped the repository while the leaf check
// still passed. D55 requires every component to be verified from the repo root,
// exactly as `admission-record.mjs` does for admission records.
function anchoredPlainDirectory(repoRoot, target) {
  if (!plainDirectory(target)) return false;
  try {
    verifyParentPath(repoRoot, target);
    return true;
  } catch {
    return false;
  }
}

// A key that is present (even as undefined) is validated; only a key the caller
// omitted entirely is skipped, so a missing override/responsibility id fails closed.
function invalidIds(input) {
  const { repoRoot, changeId, overrideId, responsibilityId } = input;
  if (typeof repoRoot !== "string" || !repoRoot) return "repo-root-missing";
  if (typeof changeId !== "string" || !CHANGE_ID_SHAPE.test(changeId)) return "change-id-invalid";
  if (Object.hasOwn(input, "overrideId") && (typeof overrideId !== "string" || !UUID_V4_SHAPE.test(overrideId))) return "override-id-invalid";
  if (Object.hasOwn(input, "responsibilityId") && (typeof responsibilityId !== "string" || !RESPONSIBILITY_ID_SHAPE.test(responsibilityId))) return "responsibility-id-invalid";
  return null;
}

/**
 * Issue a single-use override. `issued_by` is always "user": the caller MUST
 * run this only after the user explicitly granted the override in-session and
 * MUST carry the user's wording in `reason`. Writes only into the active
 * change folder (never into an archived one).
 */
export function issueHalfStateOverride({ repoRoot, changeId, responsibilityId, reason, uuid = randomUUID, now = () => new Date(), hooks = {} }) {
  const invalid = invalidIds({ repoRoot, changeId, responsibilityId });
  if (invalid) return { ok: false, code: invalid };
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > REASON_MAX) return { ok: false, code: "reason-invalid" };
  const changeDir = changeDirOf(repoRoot, changeId);
  const ledgerDir = ledgerDirOf(repoRoot, changeId);
  const { fsyncDir = fsyncDirectory } = hooks;
  if (!anchoredPlainDirectory(repoRoot, changeDir)) return { ok: false, code: "override-ledger-invalid" };
  try {
    mkdirSync(ledgerDir, { recursive: false, mode: 0o700 });
    // C-05: the mkdir entry lives in `changeDir`, and `createExclusiveDurableFile`
    // below only fsyncs `ledgerDir` (the directory holding the file). Without this
    // the ledger directory itself can be absent after a crash while the override
    // JSON inside it survives, which is not a state R5's exact-once can survive.
    fsyncDir(changeDir);
  } catch (error) {
    if (error?.code !== "EEXIST") return { ok: false, code: "override-ledger-invalid" };
  }
  if (!anchoredPlainDirectory(repoRoot, ledgerDir)) return { ok: false, code: "override-ledger-invalid" };
  const overrideId = uuid();
  if (typeof overrideId !== "string" || !UUID_V4_SHAPE.test(overrideId)) return { ok: false, code: "override-id-invalid" };
  const record = {
    schema: HALF_STATE_OVERRIDE_SCHEMA,
    override_id: overrideId,
    responsibility_id: responsibilityId,
    issued_by: "user",
    issued_at: now().toISOString(),
    scope: HALF_STATE_OVERRIDE_SCOPE,
    reason: reason.trim(),
  };
  const body = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  const target = path.join(ledgerDir, `${overrideId}.json`);
  try {
    createExclusiveDurableFile({ root: repoRoot, parent: ledgerDir, target, body, hooks });
  } catch (error) {
    if (error?.code === "EEXIST") return { ok: false, code: "override-exists" };
    return { ok: false, code: typeof error?.code === "string" && error.code.includes("-") ? error.code : "override-write-failed" };
  }
  return {
    ok: true,
    override_id: overrideId,
    path: path.relative(repoRoot, target).split(path.sep).join("/"),
    digest: sha256(body),
  };
}

/** D15 (C) read path for an issued override (active or archived change folder). */
export function readHalfStateOverride({ repoRoot, changeId, overrideId }) {
  const invalid = invalidIds({ repoRoot, changeId, overrideId });
  if (invalid) return { ok: false, code: invalid };
  const ledgerDir = readLedgerDirOf(repoRoot, changeId);
  if (ledgerDir === null) return { ok: false, code: "override-unreadable" };
  return readOverrideRecord(repoRoot, ledgerDir, overrideId);
}

function readOverrideRecord(repoRoot, ledgerDir, overrideId) {
  let bytes;
  try {
    ({ bytes } = readNoFollowFile({ root: repoRoot, parent: ledgerDir, target: path.join(ledgerDir, `${overrideId}.json`), maxBytes: RECORD_MAX_BYTES }));
  } catch {
    return { ok: false, code: "override-unreadable" };
  }
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, code: "override-malformed" };
  }
  const keys = record && typeof record === "object" && !Array.isArray(record) ? Object.keys(record).sort() : null;
  if (
    keys === null
    || keys.join("\0") !== [...OVERRIDE_RECORD_KEYS].sort().join("\0")
    || record.schema !== HALF_STATE_OVERRIDE_SCHEMA
    || record.override_id !== overrideId
    || record.scope !== HALF_STATE_OVERRIDE_SCOPE
    || record.issued_by !== "user"
    || typeof record.responsibility_id !== "string" || !RESPONSIBILITY_ID_SHAPE.test(record.responsibility_id)
    || typeof record.issued_at !== "string" || !Number.isFinite(Date.parse(record.issued_at))
    || typeof record.reason !== "string" || record.reason.trim().length === 0
  ) {
    return { ok: false, code: "override-malformed" };
  }
  return { ok: true, record, digest: sha256(bytes) };
}

/** issued | claimed-incomplete | consumed | missing (audit/telemetry helper). */
export function halfStateOverrideStatus({ repoRoot, changeId, overrideId }) {
  if (invalidIds({ repoRoot, changeId, overrideId })) return "missing";
  const ledgerDir = readLedgerDirOf(repoRoot, changeId);
  if (ledgerDir === null || !readOverrideRecord(repoRoot, ledgerDir, overrideId).ok) return "missing";
  const claimDir = path.join(ledgerDir, `${overrideId}.claim`);
  if (!plainDirectory(claimDir)) return "issued";
  try {
    readNoFollowFile({ root: repoRoot, parent: claimDir, target: path.join(claimDir, "consumed.json"), maxBytes: RECORD_MAX_BYTES });
    return "consumed";
  } catch {
    return "claimed-incomplete";
  }
}

/**
 * Prove that one consumed exact-once override is durably bound to a dispatch.
 * Receipt/chain validation uses this for bounded counts past the automatic cap;
 * the reviewer payload need not echo an override id, and unrelated malformed
 * ledger entries cannot manufacture a positive match.
 */
export function hasConsumedHalfStateOverrideClaim({ repoRoot, changeId, responsibilityId, dispatchId }) {
  const invalid = invalidIds({ repoRoot, changeId, responsibilityId });
  if (invalid || typeof dispatchId !== "string" || !DISPATCH_ID_SHAPE.test(dispatchId)) return false;
  const ledgerDir = readLedgerDirOf(repoRoot, changeId);
  if (ledgerDir === null || !anchoredPlainDirectory(repoRoot, ledgerDir)) return false;
  let entries;
  try {
    entries = readdirSync(ledgerDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".claim")) continue;
    const overrideId = entry.name.slice(0, -".claim".length);
    if (!UUID_V4_SHAPE.test(overrideId)) continue;
    const loaded = readOverrideRecord(repoRoot, ledgerDir, overrideId);
    if (!loaded.ok || loaded.record.responsibility_id !== responsibilityId) continue;
    const claimDir = path.join(ledgerDir, entry.name);
    if (!anchoredPlainDirectory(repoRoot, claimDir)) continue;
    let proof;
    try {
      const { bytes } = readNoFollowFile({
        root: repoRoot,
        parent: claimDir,
        target: path.join(claimDir, "consumed.json"),
        maxBytes: RECORD_MAX_BYTES,
      });
      proof = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue;
    }
    const keys = proof && typeof proof === "object" && !Array.isArray(proof) ? Object.keys(proof).sort() : null;
    if (keys === null
      || keys.join("\0") !== ["consumed_at", "dispatch_id", "override_id", "schema"].join("\0")
      || proof.schema !== HALF_STATE_OVERRIDE_CLAIM_SCHEMA
      || proof.override_id !== overrideId
      || proof.dispatch_id !== dispatchId
      || typeof proof.consumed_at !== "string"
      || !Number.isFinite(Date.parse(proof.consumed_at))) continue;
    return true;
  }
  return false;
}

/**
 * Exact-once claim, performed in the same step that issues a dispatch_id.
 * Returns { ok: true, consumed_at } for the sole winner; every other outcome
 * is { ok: false, code } and MUST be treated as "no authorization":
 *   responsibility-mismatch — override bound to another responsibility_id
 *   already-claimed         — claimed-incomplete or consumed (any EEXIST)
 *   claim-dir-invalid       — ledger/claim directory is not a plain directory
 *   consumed-write-failed   — claim taken but proof not durable (stays
 *                             claimed-incomplete; not authorized)
 *   plus the read-path codes of readHalfStateOverride.
 */
export function claimHalfStateOverride({ repoRoot, changeId, overrideId, responsibilityId, dispatchId, budgetState = "unavailable", now = () => new Date(), hooks = {} }) {
  const invalid = invalidIds({ repoRoot, changeId, overrideId, responsibilityId });
  if (invalid) return { ok: false, code: invalid };
  if (typeof dispatchId !== "string" || !DISPATCH_ID_SHAPE.test(dispatchId)) return { ok: false, code: "dispatch-id-invalid" };
  // `budgetState` is validated and then goes no further. It used to refuse the
  // claim outright at `exhausted` (code `budget-exhausted`, now removed along
  // with the caller's matching hard stop): a third gate on the same three
  // cumulative totals `fix-zero-value-review-rounds` R1/D19 demoted to
  // advisory, and D18 states the field has no routing effect at all. Leaving
  // it would have been worse than redundant -- the stall budget's handback
  // (D6) is reopened by exactly this override, so a chain that stalled while
  // the totals happened to be high would have had the user's named
  // authorization refused for a reason the change exists to stop honoring.
  if (!BUDGET_STATES.includes(budgetState)) return { ok: false, code: "budget-state-invalid" };
  // Active folder only: an archived change's override never authorizes a new dispatch.
  const ledgerDir = ledgerDirOf(repoRoot, changeId);
  const loaded = readOverrideRecord(repoRoot, ledgerDir, overrideId);
  if (!loaded.ok) return loaded;
  if (loaded.record.responsibility_id !== responsibilityId) return { ok: false, code: "responsibility-mismatch" };
  const { fsyncDir = fsyncDirectory } = hooks;
  if (!anchoredPlainDirectory(repoRoot, ledgerDir)) return { ok: false, code: "claim-dir-invalid" };
  const claimDir = path.join(ledgerDir, `${overrideId}.claim`);
  try {
    mkdirSync(claimDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") return { ok: false, code: "already-claimed" };
    return { ok: false, code: "claim-dir-invalid" };
  }
  // C-05: the claim directory IS the exact-once proof. Its mkdir entry lives in
  // `ledgerDir`, which nothing else fsyncs, so a crash could drop the claim while
  // leaving `<override_id>.json` behind — and the same override would authorize a
  // second dispatch. `admission-record.mjs` already fsyncs the parent this way.
  fsyncDir(ledgerDir);
  if (!plainDirectory(claimDir)) return { ok: false, code: "claim-dir-invalid" };
  const consumedAt = now().toISOString();
  const proof = { schema: HALF_STATE_OVERRIDE_CLAIM_SCHEMA, override_id: overrideId, dispatch_id: dispatchId, consumed_at: consumedAt };
  try {
    createExclusiveDurableFile({
      root: repoRoot,
      parent: claimDir,
      target: path.join(claimDir, "consumed.json"),
      body: Buffer.from(`${JSON.stringify(proof, null, 2)}\n`, "utf8"),
      hooks,
    });
    fsyncDir(ledgerDir);
  } catch {
    return { ok: false, code: "consumed-write-failed" };
  }
  return { ok: true, override_id: overrideId, dispatch_id: dispatchId, consumed_at: consumedAt };
}
