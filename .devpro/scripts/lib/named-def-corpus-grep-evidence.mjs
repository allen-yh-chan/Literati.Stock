/**
 * Machine-parseable Named-Definition Corpus-Grep Evidence for --pre-review.
 *
 * Doctrine (`dry-ssot-corpus.md` P3): authors declare NEW named definitions
 * cooperatively; this module never regex-judges materiality from the diff.
 * Missing / incomplete evidence fails closed before six-axis reviewer dispatch.
 */
import {
  countH2Sections,
  extractSection,
} from "./clarification-contract.mjs";

export const NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING =
  "Named-Definition Corpus-Grep Evidence";

const REQUIRED_DEF_FIELDS = Object.freeze(["name", "scope", "disposition"]);

const MALFORMED_MISSING = Object.freeze([
  "(undeclared — evidence malformed)",
]);

const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)\n```/gi;

/**
 * @param {string} [reason]
 * @returns {string}
 */
export function noneEvidenceMarkdown(
  reason = "no new named definitions introduced",
) {
  return [
    `## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING}`,
    "",
    "```json",
    JSON.stringify({ status: "none", reason }, null, 2),
    "```",
    "",
  ].join("\n");
}

/**
 * @param {Array<{
 *   name: string,
 *   scope: string,
 *   hits?: string | number | unknown[],
 *   results?: string | number | unknown[],
 *   disposition: string,
 * }>} definitions
 * @returns {string}
 */
export function presentEvidenceMarkdown(definitions) {
  return [
    `## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING}`,
    "",
    "```json",
    JSON.stringify({ status: "present", definitions }, null, 2),
    "```",
    "",
  ].join("\n");
}

/**
 * @param {string} sectionBody
 * @returns {{ ok: true, json: unknown } | { ok: false, code: string, reason: string }}
 */
function extractJsonPayload(sectionBody) {
  const text = String(sectionBody || "");
  const fences = [...text.matchAll(JSON_FENCE_RE)];
  if (fences.length === 0) {
    return {
      ok: false,
      code: "json-fence-missing",
      reason:
        "section MUST contain one ```json fenced object (status none|present)",
    };
  }
  if (fences.length > 1) {
    return {
      ok: false,
      code: "json-fence-multiple",
      reason:
        "section MUST contain exactly one ```json fenced object; " +
        `found ${fences.length}`,
    };
  }
  try {
    return { ok: true, json: JSON.parse(fences[0][1]) };
  } catch (error) {
    return {
      ok: false,
      code: "json-parse-error",
      reason: `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}

/**
 * Accept string, finite number, or non-empty array for hits/results evidence.
 * @param {unknown} value
 * @returns {string}
 */
function evidenceHitsOrResults(value) {
  const asString = nonEmptyString(value);
  if (asString) return asString;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value) && value.length > 0) {
    return JSON.stringify(value);
  }
  return "";
}

/**
 * @param {string} code
 * @param {string} reason
 * @returns {{ ok: false, code: string, reason: string, missingDefinitions: string[] }}
 */
function malformed(code, reason) {
  return {
    ok: false,
    code,
    reason,
    missingDefinitions: [...MALFORMED_MISSING],
  };
}

/**
 * Evaluate proposal / proposal-mini body for corpus-grep evidence completeness.
 *
 * @param {string | null | undefined} proposalBody
 * @returns {{
 *   ok: boolean,
 *   code?: string,
 *   reason?: string,
 *   missingDefinitions?: string[],
 *   fieldGaps?: Array<{ name: string, missing: string[] }>,
 * }}
 */
export function evaluateNamedDefCorpusGrepEvidence(proposalBody) {
  if (proposalBody == null || String(proposalBody).trim() === "") {
    return malformed(
      "proposal-body-missing",
      "owned active change has no readable proposal carrier body",
    );
  }

  const body = String(proposalBody);
  const sectionCount = countH2Sections(
    body,
    NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING,
  );
  if (sectionCount > 1) {
    return malformed(
      "section-duplicate",
      `exactly one ## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING} section is required; ` +
        `found ${sectionCount}`,
    );
  }

  const section = extractSection(body, NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING);
  if (section == null) {
    return {
      ok: false,
      code: "section-missing",
      reason:
        `missing ## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING}; ` +
        "add a ```json fence with status none|present (cite dry-ssot-corpus.md P3)",
      missingDefinitions: ["(undeclared — section absent)"],
    };
  }

  const payload = extractJsonPayload(section);
  if (!payload.ok) {
    return malformed(payload.code, payload.reason);
  }

  const data = payload.json;
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return malformed("json-not-object", "evidence JSON MUST be a single object");
  }

  const status = nonEmptyString(/** @type {{ status?: unknown }} */ (data).status);
  if (status !== "none" && status !== "present") {
    return malformed(
      "status-invalid",
      'status MUST be exactly "none" or "present"',
    );
  }

  if (status === "none") {
    const reason = nonEmptyString(
      /** @type {{ reason?: unknown }} */ (data).reason,
    );
    if (!reason) {
      return malformed(
        "none-reason-missing",
        'status "none" MUST include a non-empty reason',
      );
    }
    return { ok: true, code: "none" };
  }

  const definitions = /** @type {{ definitions?: unknown }} */ (data).definitions;
  if (!Array.isArray(definitions) || definitions.length === 0) {
    return {
      ok: false,
      code: "definitions-empty",
      reason:
        'status "present" MUST list at least one definition object under definitions[]',
      missingDefinitions: ["(empty definitions[])"],
    };
  }

  /** @type {string[]} */
  const missingDefinitions = [];
  /** @type {Array<{ name: string, missing: string[] }>} */
  const fieldGaps = [];

  for (let index = 0; index < definitions.length; index += 1) {
    const entry = definitions[index];
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      missingDefinitions.push(`definitions[${index}]`);
      fieldGaps.push({
        name: `definitions[${index}]`,
        missing: ["object"],
      });
      continue;
    }
    const record = /** @type {Record<string, unknown>} */ (entry);
    const name = nonEmptyString(record.name) || `definitions[${index}]`;
    /** @type {string[]} */
    const missing = [];
    for (const field of REQUIRED_DEF_FIELDS) {
      if (!nonEmptyString(record[field])) missing.push(field);
    }
    const hits = evidenceHitsOrResults(record.hits);
    const results = evidenceHitsOrResults(record.results);
    if (!hits && !results) missing.push("hits|results");
    if (missing.length > 0) {
      missingDefinitions.push(name);
      fieldGaps.push({ name, missing });
    }
  }

  if (fieldGaps.length > 0) {
    const detail = fieldGaps
      .map((gap) => `${gap.name} missing ${gap.missing.join(", ")}`)
      .join("; ");
    return {
      ok: false,
      code: "definition-fields-incomplete",
      reason: `incomplete corpus-grep evidence: ${detail}`,
      missingDefinitions,
      fieldGaps,
    };
  }

  return { ok: true, code: "present" };
}
