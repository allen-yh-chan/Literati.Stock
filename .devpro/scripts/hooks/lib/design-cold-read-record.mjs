/**
 * design-cold-read-record.mjs
 *
 * How Gate CR reads the cold-read record. The first line is the status; a
 * releasing status counts only together with exactly one `user-answer:` line
 * that quotes what the user said when confirming in the conversation, and
 * exactly one `change:` line naming the change the record belongs to.
 *
 * The gate guards against accidents in normal work (design-core section 11):
 * a releasing status written before the user answered has no answer to quote,
 * and a record copied from another change names that other change, so neither
 * releases. It does not try to prove the user really answered; that residual
 * is an instance of `consent-record-residual` and is named in
 * `design-reasoning.md`.
 *
 * `confirm-design-cold-read.mjs` writes the answer and change lines after the
 * user answers.
 */

export const DESIGN_COLD_READ_RECORD = "comprehension.md";
export const DESIGN_COLD_READ_PENDING_LINE = "status: pending";
export const DESIGN_COLD_READ_CONFIRMED_LINE = "status: user-confirmed";
export const DESIGN_COLD_READ_UNVERIFIED_LINE = "status: user-accepted-unverified";
export const DESIGN_COLD_READ_ANSWER_PREFIX = "user-answer:";
export const DESIGN_COLD_READ_CHANGE_PREFIX = "change:";

const RELEASING_LINES = new Set([DESIGN_COLD_READ_CONFIRMED_LINE, DESIGN_COLD_READ_UNVERIFIED_LINE]);
// Records signed by the earlier terminal command carry ` proof=<hex>` on the
// status line. The status still reads, so the gate can say what to redo.
const LEGACY_PROOF_LINE_RE = /^(status: [a-z-]+) proof=[0-9a-f]{64}$/;

/** The physical first line. A blank first line is a blank status, not a skipped one. */
export function firstLineOf(content) {
  return String(content ?? "").split("\n")[0].trimEnd();
}

/** The status a first line carries, with any legacy proof removed. */
export function designColdReadStatusOf(firstLine) {
  return firstLine.match(LEGACY_PROOF_LINE_RE)?.[1] ?? firstLine;
}

export function isDesignColdReadReleasingStatus(firstLine) {
  return RELEASING_LINES.has(designColdReadStatusOf(firstLine));
}

// The trimmed values of every line below the status line that starts with the prefix.
function prefixedValues(content, prefix) {
  return String(content ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

/** The quoted answer when there is exactly one non-empty `user-answer:` line, else null. */
export function designColdReadAnswerOf(content) {
  const answers = prefixedValues(content, DESIGN_COLD_READ_ANSWER_PREFIX);
  return answers.length === 1 && answers[0].length > 0 ? answers[0] : null;
}

/** Every value the record's `change:` lines name, in order. */
export function designColdReadChangeNames(content) {
  return prefixedValues(content, DESIGN_COLD_READ_CHANGE_PREFIX);
}

/**
 * True only when the first line is exactly a releasing status, the record
 * quotes the user's answer once, and its one `change:` line names `changeName`.
 */
export function isDesignColdReadRecordReleased({ content, changeName }) {
  if (!RELEASING_LINES.has(firstLineOf(content))) return false;
  if (designColdReadAnswerOf(content) === null) return false;
  const names = designColdReadChangeNames(content);
  return names.length === 1 && names[0] === changeName;
}
