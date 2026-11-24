// Single source of the PR body evidence rules. The second-review handoff builder
// (build-pr-sticky-handoff.mjs) and the pre-create body lint (pre-pr-body-template-check.mjs)
// both call these functions, so they measure the same text with the same limits and wording.
// Spec: openspec change strengthen-pre-pr-evidence-section-lint (design D1, D3, D4, D7).
import { SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES } from "../second-review-material-contract.mjs";
import { SCOPE_SUMMARY_MAX_BYTES } from "../validate-second-review-packet.mjs";
import { closesFence, fenceDelimiter } from "./markdown-fence-aware.mjs";
import { findH2Section as findExactH2Section, h2SectionBody as sectionBody } from "./markdown-h2-section.mjs";

export const PR_EVIDENCE_SECTION_MAX_BYTES = SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES;
export const PR_CHANGE_CONTEXT_MAX_BYTES = SCOPE_SUMMARY_MAX_BYTES;

// Handoff field -> PR body sections that feed it (their trimmed text is joined by one blank line).
export const PR_EVIDENCE_FIELDS = Object.freeze({
  primary_validation_evidence: Object.freeze(["OpenSpec", "Requirement Ledger Completion"]),
  primary_test_evidence: Object.freeze(["Test Evidence"]),
});

const BACKTICK = String.fromCharCode(96);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000e-\u001f\u007f]/;
const ANGLE_FIELD = "<[^>]+>";
// Literal words keep their old behavior: TODO and TBD need word boundaries, the other two do not.
const EVIDENCE_WORDS_SOURCE = `${ANGLE_FIELD}|\\bTODO\\b|\\bTBD\\b|\\[fill|placeholder`;
const CHANGE_CONTEXT_WORDS_SOURCE = `${ANGLE_FIELD}|\\bTODO\\b|\\bTBD\\b|placeholder`;
const SINGLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._#:/@+-]*$/;

// The section reader lives in lib/markdown-h2-section.mjs (no imports).
export { findExactH2Section, sectionBody };

// Trimmed non-empty section texts of one evidence field, in heading order.
function evidenceSections(body, headings) {
  return headings.map((heading) => sectionBody(body, heading)).filter(Boolean);
}

// The measured unit of an evidence field: sections trimmed, empty ones dropped, joined by one blank line.
export function extractEvidenceText(body, headings) {
  return evidenceSections(body, headings).join("\n\n");
}

export function extractScopeSummary(body) {
  const context = sectionBody(body, "Change Context");
  const lines = context.split(/\r\n|[\r\n]/)
    .map((line) => line.replace(/^[-*+][ \t]+/, "").replace(/[\t\v\f]+/g, " ").trim())
    .filter(Boolean);
  return lines.join(" ");
}

export function scopeSummaryOverLimit(summary) {
  const bytes = Buffer.byteLength(summary, "utf8");
  return bytes > PR_CHANGE_CONTEXT_MAX_BYTES ? { bytes, limit: PR_CHANGE_CONTEXT_MAX_BYTES } : null;
}

// Character ranges [start, end) of the fenced blocks and inline code spans of one section text.
function codeRegions(text) {
  const regions = [];
  let offset = 0;
  let open = null;
  let openStart = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;
    const delimiter = fenceDelimiter(line);
    if (open !== null) {
      if (delimiter && closesFence(delimiter, open)) {
        regions.push([openStart, lineEnd]);
        open = null;
      }
      continue;
    }
    if (delimiter) {
      open = delimiter;
      openStart = lineStart;
      continue;
    }
    regions.push(...inlineSpans(line, lineStart));
  }
  if (open !== null) regions.push([openStart, text.length]);
  return regions;
}

// A span opens with a run of N backticks and closes at the next run of exactly N; it never crosses a line.
function inlineSpans(line, lineStart) {
  const runs = [];
  for (let index = 0; index < line.length;) {
    if (line[index] !== BACKTICK) { index += 1; continue; }
    let end = index;
    while (line[end] === BACKTICK) end += 1;
    runs.push({ start: index, length: end - index });
    index = end;
  }
  const spans = [];
  for (let at = 0; at < runs.length; at += 1) {
    const close = runs.findIndex((run, position) => position > at && run.length === runs[at].length);
    if (close === -1) continue;
    spans.push([lineStart + runs[at].start, lineStart + runs[close].start + runs[close].length]);
    at = close;
  }
  return spans;
}

function isSingleIdentifierField(field) {
  const inner = field.slice(1, -1);
  return SINGLE_IDENTIFIER.test(inner) && !inner.includes("..");
}

function unfilledEvidenceMatches(sectionText) {
  const text = sectionText.replace(/\r\n|\r/g, "\n");
  const regions = codeRegions(text);
  const found = [];
  for (const match of text.matchAll(new RegExp(EVIDENCE_WORDS_SOURCE, "gi"))) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    const isField = token.startsWith("<");
    const allowed = isField && isSingleIdentifierField(token) && regions.some(([from, to]) => from <= start && end <= to);
    if (!allowed) found.push(token);
  }
  return found;
}

// Returns every unfilled-template match in order; an empty list means the text is clean.
// profile "evidence": angle fields pass only as one ASCII identifier inside code (design D3); `text` is one original section.
// profile "change-context": the builder's original rule, no relaxation (design D4).
export function findUnfilledTemplateText(text, { profile } = {}) {
  if (profile === "evidence") return unfilledEvidenceMatches(String(text ?? ""));
  if (profile === "change-context") return [...String(text ?? "").matchAll(new RegExp(CHANGE_CONTEXT_WORDS_SOURCE, "gi"))].map((match) => match[0]);
  throw new Error(`unknown unfilled-template profile: ${String(profile)}`);
}

function unique(values) {
  return [...new Set(values)];
}

function finding({ section, field, kind, bytes = 0, limit = 0, matches = [], classification = "pr_evidence_invalid" }) {
  return { section, field, kind, bytes, limit, matches, classification };
}

// Findings of one evidence field, in the order empty, unfilled-template, over-limit. The unfilled judgment is
// per original section; only the byte count uses the joined text (the builder's measured unit).
export function evidenceFieldFindings(body, field) {
  const headings = PR_EVIDENCE_FIELDS[field];
  if (!headings) throw new Error(`unknown evidence field: ${String(field)}`);
  const section = headings.map((heading) => `## ${heading}`).join(" + ");
  const sections = evidenceSections(body, headings);
  if (sections.length === 0) return [finding({ section, field, kind: "empty" })];
  const findings = [];
  const matches = unique(sections.flatMap((text) => findUnfilledTemplateText(text, { profile: "evidence" })));
  if (matches.length > 0) findings.push(finding({ section, field, kind: "unfilled-template", matches }));
  const bytes = Buffer.byteLength(sections.join("\n\n"), "utf8");
  if (bytes > PR_EVIDENCE_SECTION_MAX_BYTES) findings.push(finding({ section, field, kind: "over-limit", bytes, limit: PR_EVIDENCE_SECTION_MAX_BYTES }));
  return findings;
}

// Findings of the Change Context: control-characters, empty, unfilled-template, then over-limit (the only
// handoff_limit_exceeded one). Each is measured on the normalized scope_summary.
export function changeContextFindings(body) {
  const summary = extractScopeSummary(body);
  const base = { section: "## Change Context", field: "scope_summary" };
  const findings = [];
  if (CONTROL_CHARACTERS.test(summary)) findings.push(finding({ ...base, kind: "control-characters" }));
  if (!summary) findings.push(finding({ ...base, kind: "empty" }));
  else {
    const matches = unique(findUnfilledTemplateText(summary, { profile: "change-context" }));
    if (matches.length > 0) findings.push(finding({ ...base, kind: "unfilled-template", matches }));
  }
  const over = scopeSummaryOverLimit(summary);
  if (over) findings.push(finding({ ...base, kind: "over-limit", bytes: over.bytes, limit: over.limit, classification: "handoff_limit_exceeded" }));
  return findings;
}

// One message shape for both carriers: the fact first (section, bytes, limit or matched wording).
export function formatEvidenceFinding(item) {
  const label = item.field === "scope_summary"
    ? `${item.section} (normalized scope_summary)`
    : item.section.includes(" + ") ? `${item.section} (joined with one blank line)` : item.section;
  if (item.kind === "over-limit") {
    const cjk = item.field === "scope_summary" ? ` (about ${Math.floor(item.limit / 3)} CJK characters)` : "";
    return `${label}: ${item.bytes} UTF-8 bytes; limit ${item.limit}${cjk}`;
  }
  if (item.kind === "unfilled-template") return `${item.section}: unfilled template text ${item.matches.map((match) => JSON.stringify(match)).join(", ")}`;
  if (item.kind === "control-characters") return `${item.section}: contains unsupported control characters`;
  return `${item.section}: empty or missing`;
}
