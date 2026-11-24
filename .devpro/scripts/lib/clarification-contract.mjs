/**
 * clarification-contract.mjs
 *
 * Executable validators for Clarification State + Seams Confirmation
 * (SSOT prose: ambiguity-scoring.md / proposal-template.md).
 * Pure functions — no I/O. Used by unit tests; TL MAY call from scripts.
 *
 * Sensitive-data patterns align with Gate P (pre-tool-gate.mjs findPIIHits)
 * plus secret/transcript markers used by clarification leaf.
 */

import { createHash } from "node:crypto";
import {
  findPIIHits,
  isValidHitResult as isValidSharedPIIResult,
} from "./pii-pattern-contract.mjs";
import { countLiveH2Sections, extractLiveH2Section } from "./markdown-fence-aware.mjs";

/**
 * Canonical seams text for content-bound fingerprinting (#2480).
 * NFC + LF newlines + strip trailing spaces per line + trim trailing newlines.
 * @param {string} seams
 * @returns {string}
 */
export function canonicalizeSeamsContent(seams) {
  return String(seams ?? "")
    .normalize("NFC")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/u, "");
}

/**
 * SHA-256 hex of canonical seams — the only legal `seams_fingerprint` value.
 * @param {string} seams
 * @returns {string}
 */
export function computeSeamsContentFingerprint(seams) {
  return createHash("sha256")
    .update(canonicalizeSeamsContent(seams), "utf8")
    .digest("hex");
}

const PROVENANCE_SUFFIX = /\(provenance:\s*(user|repo-fact)\)\s*$/;

const SECRETISH_RE =
  /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const TRANSCRIPT_RE = /\b(full\s+transcript|完整\s*transcript|對話全文)\b/i;

const REQUIRED_CLARIFICATION_KEYS = Object.freeze([
  "round",
  "extension_used",
  "round4_completed",
  "cap_hit",
  "cap_resolution",
  "cap_resolution_provenance",
  "frontier",
  "unresolved",
  "decisions",
  "shared_understanding",
  "shared_understanding_provenance",
  "terminal",
  "gaps_written",
]);

const REQUIRED_SEAMS_KEYS = Object.freeze([
  "seams",
  "confirmed",
  "provenance",
  "bypass",
  "bypass_reason",
  "seams_fingerprint",
  "reconfirm_required",
  "invalidation_reason",
]);

/**
 * @param {Record<string, string>} src
 * @param {readonly string[]} allowedKeys
 * @returns {string[]}
 */
function rejectUnknownFields(src, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const errors = [];
  for (const [key, value] of Object.entries(src || {})) {
    if (allowed.has(key)) continue;
    errors.push(`unknown field: ${key}`);
    for (const hit of detectSensitiveHits(key)) {
      errors.push(`sensitive ${hit} in unknown field name`);
    }
    for (const hit of detectSensitiveHits(String(value ?? ""))) {
      errors.push(`sensitive ${hit} in unknown field ${key}`);
    }
  }
  return errors;
}

/**
 * @param {string} md
 * @param {string} heading
 * @returns {number}
 */
export function countH2Sections(md, heading) {
  return countLiveH2Sections(md, heading);
}

/**
 * @param {string} md
 * @param {string} heading
 * @returns {string | null}
 */
export function extractSection(md, heading) {
  if (countLiveH2Sections(md, heading) === 0) return null;
  return extractLiveH2Section(md, heading);
}

/**
 * Strict bullet parse: duplicate keys / unrecognized non-empty lines fail closed.
 * Unrecognized lines are also scanned for sensitive content.
 * @param {string} section
 * @returns {{ fields: Record<string, string>, errors: string[] }}
 */
const FORBIDDEN_FIELD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseBulletFields(section) {
  /** @type {Record<string, string>} null-prototype — blocks inherited setters */
  const fields = Object.create(null);
  /** @type {string[]} */
  const errors = [];
  const seen = new Set();
  for (const raw of String(section || "").split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^- ([^:]+):\s*(.*)$/);
    if (!m) {
      errors.push(`unrecognized line: ${trimmed.slice(0, 60)}`);
      for (const hit of detectSensitiveHits(trimmed)) {
        errors.push(`sensitive ${hit} in unrecognized line`);
      }
      continue;
    }
    const key = m[1].trim();
    if (FORBIDDEN_FIELD_KEYS.has(key)) {
      errors.push(`forbidden field name: ${key}`);
      for (const hit of detectSensitiveHits(m[2].trim())) {
        errors.push(`sensitive ${hit} in forbidden field ${key}`);
      }
      continue;
    }
    if (seen.has(key)) {
      errors.push(`duplicate field: ${key}`);
      continue;
    }
    seen.add(key);
    fields[key] = m[2].trim();
  }
  return { fields, errors };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function detectSensitiveHits(text) {
  if (!text) return [];
  let sharedHits;
  try {
    sharedHits = findPIIHits(text);
  } catch {
    return ["pii-classification-failure"];
  }
  if (!isValidSharedPIIResult(sharedHits)) {
    return ["pii-classification-failure"];
  }

  const sharedLabel = {
    email: "email-like",
    "unix-users-path": "unix-users-path",
    "unix-home-path": "unix-home-path",
    "windows-users-path": "windows-users-path",
  };
  const hits = sharedHits.map((hit) => sharedLabel[hit.type]);
  if (SECRETISH_RE.test(text)) hits.push("secret-like");
  if (TRANSCRIPT_RE.test(text)) hits.push("transcript-like");
  return hits;
}

function isEmptyListValue(listText) {
  return (
    !listText ||
    listText === "[]" ||
    listText === "(empty)" ||
    listText === "empty"
  );
}

/**
 * Cap-hit is declared OR derived: working-cap round (≥3) with non-empty frontier
 * (ambiguity-scoring Cap-hit: cap_hit=true 或 round 3 結束且 frontier 非空).
 * @param {Record<string, string>} fields
 * @param {boolean} [frontierEmpty]
 */
function isEffectiveCapHit(fields, frontierEmpty = isEmptyListValue(fields?.frontier)) {
  if (fields?.cap_hit === "true") return true;
  const round = Number(fields?.round);
  return Number.isFinite(round) && round >= 3 && !frontierEmpty;
}

/**
 * @param {string} listText
 * @returns {string[]}
 */
export function splitListItems(listText) {
  return listText.includes(";")
    ? listText.split(";").map((s) => s.trim()).filter(Boolean)
    : listText.includes("|")
      ? listText.split("|").map((s) => s.trim()).filter(Boolean)
      : [listText];
}

/**
 * round 21/F-page18: `splitListItems` only ever splits on ONE separator
 * (priority: `;` then `|`), so a value that already contains BOTH is a
 * pre-existing "MUST NOT mix" violation whose non-`;`-delimited items get
 * silently merged into the chunk `splitListItems` produces for them. Callers
 * writing a new answer MUST check this before appending — see
 * `frontend-theming-and-i18n.md`'s write-obligation fail-closed clause.
 * @param {string} listText
 * @returns {boolean}
 */
export function hasMixedListSeparators(listText) {
  return listText.includes(";") && listText.includes("|");
}

/**
 * @param {string} listText
 * @param {{ maxItems: number, maxChars: number, requireProvenance?: boolean, unresolvedPrefix?: boolean }} opts
 * @returns {string[]}
 */
function validateBulletList(listText, opts) {
  const errors = [];
  if (isEmptyListValue(listText)) return errors;
  const items = splitListItems(listText);
  if (items.length > opts.maxItems) {
    errors.push(`list exceeds ${opts.maxItems} items (${items.length})`);
  }
  for (const item of items) {
    if (item.length > opts.maxChars) {
      errors.push(`item exceeds ${opts.maxChars} chars: ${item.slice(0, 40)}…`);
    }
    if (opts.unresolvedPrefix && !item.startsWith("UNRESOLVED:")) {
      errors.push(`unresolved item missing UNRESOLVED: prefix`);
    }
    if (opts.requireProvenance && !PROVENANCE_SUFFIX.test(item)) {
      errors.push(`item missing (provenance: user|repo-fact): ${item.slice(0, 40)}`);
    }
    for (const hit of detectSensitiveHits(item)) {
      errors.push(`sensitive ${hit} in item`);
    }
  }
  return errors;
}

/**
 * @param {Record<string, string>} fields
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateClarificationStateFields(fields) {
  const errors = [];
  const src = fields && typeof fields === "object" ? fields : {};

  errors.push(...rejectUnknownFields(src, REQUIRED_CLARIFICATION_KEYS));

  for (const key of REQUIRED_CLARIFICATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key) || src[key] === undefined || src[key] === null) {
      errors.push(`missing required field: ${key}`);
    }
  }
  // Fail closed on incomplete / unknown-key records before interpreting defaults.
  if (errors.length > 0) return { ok: false, errors };

  const round = Number(src.round);
  if (![1, 2, 3, 4].includes(round)) errors.push("round must be 1|2|3|4");

  for (const key of [
    "extension_used",
    "round4_completed",
    "cap_hit",
    "gaps_written",
  ]) {
    if (!/^(true|false)$/.test(src[key])) {
      errors.push(`${key} must be true|false`);
    }
  }

  const capRes = src.cap_resolution;
  if (!["none", "extend", "split", "carry-gaps"].includes(capRes)) {
    errors.push("cap_resolution invalid");
  }
  const capProv = src.cap_resolution_provenance;
  if (!["none", "user"].includes(capProv)) {
    errors.push("cap_resolution_provenance invalid");
  }
  if (capRes !== "none" && capProv !== "user") {
    errors.push("cap_resolution requires cap_resolution_provenance=user");
  }
  if (capRes === "extend" && src.extension_used !== "true") {
    errors.push("cap_resolution=extend requires extension_used=true");
  }
  if (src.extension_used === "true" && capRes !== "extend") {
    errors.push("extension_used=true requires cap_resolution=extend");
  }
  // round4_completed claims absolute-max extension finished → must be on round 4
  if (src.round4_completed === "true" && round !== 4) {
    errors.push("round4_completed=true requires round=4");
  }
  // Extension / round-4 path must record a prior working-cap hit (durable transition).
  if (
    (round === 4 ||
      capRes === "extend" ||
      src.extension_used === "true" ||
      src.round4_completed === "true") &&
    src.cap_hit !== "true"
  ) {
    errors.push(
      "extend/round=4 requires cap_hit=true (recorded working-cap transition)",
    );
  }

  const su = src.shared_understanding;
  if (!["pending", "confirmed"].includes(su)) {
    errors.push("shared_understanding invalid");
  }
  const suProv = src.shared_understanding_provenance;
  if (!["none", "user"].includes(suProv)) {
    errors.push("shared_understanding_provenance invalid");
  }

  const terminal = src.terminal;
  if (
    ![
      "none",
      "split",
      "carry-gaps",
      "frontier-empty",
      "shared-understanding",
      "abort",
    ].includes(terminal)
  ) {
    errors.push("terminal invalid");
  }

  errors.push(
    ...validateBulletList(src.frontier, {
      maxItems: 20,
      maxChars: 200,
      requireProvenance: true,
    }).map((e) => `frontier: ${e}`),
  );
  errors.push(
    ...validateBulletList(src.unresolved, {
      maxItems: 20,
      maxChars: 200,
      requireProvenance: true,
      unresolvedPrefix: true,
    }).map((e) => `unresolved: ${e}`),
  );
  errors.push(
    ...validateBulletList(src.decisions, {
      maxItems: 20,
      maxChars: 200,
      requireProvenance: true,
    }).map((e) => `decisions: ${e}`),
  );

  const frontierEmpty = isEmptyListValue(src.frontier);
  if (round === 4 && src.extension_used !== "true") {
    errors.push("round=4 requires extension_used=true");
  }
  if (round === 4 && capRes !== "extend") {
    errors.push("round=4 requires cap_resolution=extend");
  }
  if (round >= 3 && !frontierEmpty && src.cap_hit !== "true") {
    errors.push("round>=3 with non-empty frontier requires cap_hit=true");
  }
  if (isEffectiveCapHit(src, frontierEmpty) && capRes === "none") {
    errors.push(
      "cap-hit (declared or round>=3 + non-empty frontier) requires cap_resolution≠none",
    );
  }
  if (
    (capRes === "carry-gaps" || terminal === "carry-gaps") &&
    isEmptyListValue(src.unresolved)
  ) {
    errors.push(
      "carry-gaps requires non-empty unresolved with UNRESOLVED: durable gap evidence",
    );
  }
  if (!frontierEmpty && su === "confirmed" && suProv !== "user") {
    errors.push(
      "non-empty frontier + shared_understanding=confirmed requires shared_understanding_provenance=user",
    );
  }
  if (terminal === "frontier-empty" && !frontierEmpty) {
    errors.push("terminal=frontier-empty contradicts non-empty frontier");
  }
  if (terminal === "shared-understanding" && su !== "confirmed") {
    errors.push("terminal=shared-understanding requires shared_understanding=confirmed");
  }
  if (terminal === "shared-understanding" && suProv !== "user") {
    errors.push("terminal=shared-understanding requires shared_understanding_provenance=user");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Analyst dispatch gate (cap-hit / terminal / write-back paths).
 * Incomplete records fail closed (must pass validateClarificationStateFields first).
 * @param {Record<string, string>} fields
 * @param {{ writeBackFailed?: boolean, writeBackAbortRecorded?: boolean }} [ctx]
 * @returns {{ allowed: boolean, reason: string }}
 */
export function analystDispatchGate(fields, ctx = {}) {
  if (ctx.writeBackFailed) {
    if (ctx.writeBackAbortRecorded) {
      return { allowed: false, reason: "write-back abort recorded; analyst forbidden" };
    }
    return { allowed: false, reason: "write-back failed without recorded terminal" };
  }

  const shape = validateClarificationStateFields(fields || {});
  if (!shape.ok) {
    return { allowed: false, reason: `invalid clarification state: ${shape.errors[0]}` };
  }

  const capHitDeclared = fields.cap_hit === "true";
  const capRes = fields.cap_resolution;
  const terminal = fields.terminal;
  const su = fields.shared_understanding;
  const suProv = fields.shared_understanding_provenance;
  const frontierEmpty = isEmptyListValue(fields.frontier);
  const round = Number(fields.round);
  const effectiveCapHit = isEffectiveCapHit(fields, frontierEmpty);

  if (terminal === "abort" || terminal === "split" || capRes === "split") {
    return {
      allowed: false,
      reason:
        capRes === "split"
          ? "cap_resolution=split forbids analyst"
          : `terminal=${terminal}`,
    };
  }

  if (round === 4 && fields.extension_used !== "true") {
    return { allowed: false, reason: "round=4 without recorded extension" };
  }

  if (effectiveCapHit && capRes === "none") {
    return {
      allowed: false,
      reason: capHitDeclared
        ? "cap_hit with unresolved cap_resolution"
        : "round>=3 + non-empty frontier requires cap_resolution before analyst",
    };
  }

  // extend must be checked before frontier-empty short-circuit
  if (capRes === "extend") {
    if (fields.cap_hit !== "true") {
      return {
        allowed: false,
        reason: "cap_resolution=extend requires cap_hit=true (recorded working-cap transition)",
      };
    }
    if (fields.extension_used !== "true") {
      return { allowed: false, reason: "cap_resolution=extend requires extension_used=true" };
    }
    if (round !== 4) {
      return { allowed: false, reason: "cap_resolution=extend requires round=4" };
    }
    if (fields.round4_completed !== "true") {
      return { allowed: false, reason: "extend without round4_completed" };
    }
    if (!frontierEmpty && terminal !== "carry-gaps") {
      return { allowed: false, reason: "post-extend frontier still non-empty without carry-gaps" };
    }
  } else if (fields.extension_used === "true") {
    // stale extension_used without extend resolution is inconsistent (cap_hit irrelevant)
    return { allowed: false, reason: "extension_used=true requires cap_resolution=extend" };
  }

  if (capRes === "carry-gaps" || terminal === "carry-gaps") {
    if (terminal !== "carry-gaps") {
      return {
        allowed: false,
        reason: "carry-gaps requires terminal=carry-gaps",
      };
    }
    if (fields.gaps_written !== "true") {
      return { allowed: false, reason: "carry-gaps without gaps_written" };
    }
    if (isEmptyListValue(fields.unresolved)) {
      return {
        allowed: false,
        reason: "carry-gaps without durable unresolved UNRESOLVED: evidence",
      };
    }
    return {
      allowed: true,
      reason: "carry-gaps with gaps_written + terminal + unresolved evidence",
    };
  }

  if (terminal === "frontier-empty") {
    // validateClarificationStateFields already rejects non-empty frontier contradiction
    return { allowed: true, reason: "terminal=frontier-empty" };
  }

  if (frontierEmpty) {
    return { allowed: true, reason: "frontier empty" };
  }

  // Post-cap: shared_understanding alone MUST NOT satisfy (ambiguity-scoring Post-cap)
  if (effectiveCapHit) {
    return {
      allowed: false,
      reason: "post-cap cannot satisfy with shared_understanding alone",
    };
  }

  if (su === "confirmed") {
    if (suProv !== "user") {
      return {
        allowed: false,
        reason: "shared_understanding=confirmed without shared_understanding_provenance=user",
      };
    }
    return { allowed: true, reason: "shared_understanding confirmed with user provenance" };
  }

  return { allowed: false, reason: "frontier non-empty without confirmed understanding or terminal" };
}

/**
 * @param {Record<string, string>} fields
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSeamsConfirmationFields(fields) {
  const errors = [];
  const src = fields && typeof fields === "object" ? fields : {};
  errors.push(...rejectUnknownFields(src, REQUIRED_SEAMS_KEYS));
  for (const key of REQUIRED_SEAMS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key) || src[key] === undefined || src[key] === null) {
      errors.push(`missing required field: ${key}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  errors.push(
    ...validateBulletList(src.seams, {
      maxItems: 15,
      maxChars: 200,
      requireProvenance: false,
    }).map((e) => `seams: ${e}`),
  );
  if (isEmptyListValue(src.seams)) {
    errors.push("seams must be non-empty observable acceptance seams");
  }

  if (!/^(true|false)$/.test(src.confirmed)) {
    errors.push("confirmed must be true|false");
  }
  if (src.provenance !== "user") {
    errors.push("provenance must be user");
  }
  const bypass = src.bypass;
  if (!["none", "ask-first-recorded"].includes(bypass)) {
    errors.push("bypass invalid");
  }
  const reason = src.bypass_reason;
  if (reason.length > 200) errors.push("bypass_reason exceeds 200 chars");
  if (bypass === "ask-first-recorded" && reason.trim() === "") {
    errors.push("bypass=ask-first-recorded requires non-empty bypass_reason");
  }
  // Pending reconfirm is a first-class state: confirmed=false + bypass=none + reconfirm_required=true.
  // Only reject bare unconfirmed (no bypass and not pending reconfirm).
  if (
    src.confirmed === "false" &&
    bypass === "none" &&
    src.reconfirm_required !== "true"
  ) {
    errors.push(
      "confirmed=false requires bypass=ask-first-recorded, confirmed=true, or reconfirm_required=true (pending reconfirm)",
    );
  }
  for (const hit of detectSensitiveHits(reason)) {
    errors.push(`bypass_reason: sensitive ${hit}`);
  }
  for (const hit of detectSensitiveHits(src.seams)) {
    errors.push(`seams: sensitive ${hit}`);
  }

  if (src.seams_fingerprint.length > 64) {
    errors.push("seams_fingerprint exceeds 64 chars");
  }
  for (const hit of detectSensitiveHits(src.seams_fingerprint)) {
    errors.push(`seams_fingerprint: sensitive ${hit}`);
  }
  // Content binding (#2480): free-text labels are invalid. Mismatch ≡ seams drift
  // (same effect as reconfirm_required) — expansion gate fails closed via shape.ok=false.
  // Remediation MUST reconfirm with the user before updating the fingerprint; only
  // recomputing the hash would re-bind silently edited seams and void confirmation meaning.
  const expectedFingerprint = computeSeamsContentFingerprint(src.seams);
  if (src.seams_fingerprint !== expectedFingerprint) {
    errors.push(
      "seams_fingerprint must equal sha256(canonical(seams)) hex (content binding; free-text labels forbidden). On mismatch MUST set reconfirm_required=true + invalidation_reason=seams-change + confirmed=false, obtain user reconfirm BEFORE updating seams_fingerprint; MUST NOT only recompute the hash",
    );
  }

  if (!/^(true|false)$/.test(src.reconfirm_required)) {
    errors.push("reconfirm_required must be true|false");
  }
  if (!["none", "seams-change", "frontier-change"].includes(src.invalidation_reason)) {
    errors.push("invalidation_reason invalid");
  }
  if (src.reconfirm_required === "true" && src.invalidation_reason === "none") {
    errors.push("reconfirm_required=true requires invalidation_reason seams-change|frontier-change");
  }
  if (
    src.confirmed === "true" &&
    src.reconfirm_required === "true"
  ) {
    errors.push(
      "confirmed=true contradicts reconfirm_required=true; reconfirm before ledger expansion",
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Ledger / long-form expansion gate (proposal-template Seams-first).
 * Shape must validate (including seams_fingerprint === sha256(canonical(seams)));
 * reconfirm_required blocks expansion even if stale confirmed=true somehow slipped past
 * (validateSeamsConfirmationFields already rejects that combo). Changing `seams:` without
 * updating the fingerprint fails shape validation — same fail-closed as forgetting
 * reconfirm_required (#2480).
 * @param {Record<string, string>} fields
 * @returns {{ allowed: boolean, reason: string }}
 */
export function seamsExpansionAllowed(fields) {
  const shape = validateSeamsConfirmationFields(fields || {});
  if (!shape.ok) {
    return { allowed: false, reason: `invalid seams confirmation: ${shape.errors[0]}` };
  }
  if (fields.reconfirm_required === "true") {
    return {
      allowed: false,
      reason: "reconfirm_required; reconfirm before ledger expansion",
    };
  }
  if (fields.confirmed === "true") {
    return { allowed: true, reason: "confirmed with reconfirm_required=false" };
  }
  if (fields.bypass === "ask-first-recorded" && fields.bypass_reason.trim() !== "") {
    return { allowed: true, reason: "ask-first-recorded bypass" };
  }
  return {
    allowed: false,
    reason: "not confirmed and no recorded bypass",
  };
}

/**
 * @param {string} md meeting-notes body
 */
export function validateMeetingNotesClarificationContracts(md) {
  const errors = [];
  const body = String(md || "");

  const clarCount = countH2Sections(body, "Clarification State");
  if (clarCount === 0) {
    errors.push("missing ## Clarification State section");
  } else if (clarCount > 1) {
    errors.push("duplicate ## Clarification State section");
  } else {
    const clar = extractSection(body, "Clarification State");
    const parsed = parseBulletFields(clar);
    if (parsed.errors.length > 0) {
      errors.push(...parsed.errors.map((e) => `Clarification State: ${e}`));
    }
    const v = validateClarificationStateFields(parsed.fields);
    if (!v.ok) errors.push(...v.errors.map((e) => `Clarification State: ${e}`));
  }

  const seamsCount = countH2Sections(body, "Seams Confirmation");
  if (seamsCount === 0) {
    errors.push("missing ## Seams Confirmation section");
  } else if (seamsCount > 1) {
    errors.push("duplicate ## Seams Confirmation section");
  } else {
    const seams = extractSection(body, "Seams Confirmation");
    const parsed = parseBulletFields(seams);
    if (parsed.errors.length > 0) {
      errors.push(...parsed.errors.map((e) => `Seams Confirmation: ${e}`));
    }
    const v = validateSeamsConfirmationFields(parsed.fields);
    if (!v.ok) errors.push(...v.errors.map((e) => `Seams Confirmation: ${e}`));
  }

  return { ok: errors.length === 0, errors };
}
