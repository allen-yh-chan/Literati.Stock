/**
 * Normalizes the per-file change status that three different sources spell three
 * different ways, so the chore-A exemption can ask one question — "was this file only
 * modified in place?" — whichever source the caller read:
 *
 *   - GitHub REST  `pulls/{n}/files`   : added | removed | modified | renamed | copied | changed | unchanged
 *   - GitHub GraphQL `gh pr view --json files` changeType : ADDED | DELETED | MODIFIED | RENAMED | COPIED | CHANGED
 *   - git `diff --name-status`         : A | D | M | R<score> | C<score> | T | U | X
 *
 * Only `modified` is an in-place edit. Every other value, and every value this module does
 * not recognize (`unknown`), is NOT in-place: callers MUST treat it as the conservative
 * side (a foreign proposal that is not provably only modified still counts as proposal
 * evidence), so a new or odd status can never widen an exemption.
 *
 * Deliberately dependency-free (no imports), like `derive-change-name-from-branch.mjs`.
 */

export const CHANGE_STATUS = Object.freeze({
  ADDED: "added",
  REMOVED: "removed",
  MODIFIED: "modified",
  RENAMED: "renamed",
  COPIED: "copied",
  CHANGED: "changed",
  UNKNOWN: "unknown",
});

const NORMALIZED_BY_RAW = new Map([
  // REST
  ["added", CHANGE_STATUS.ADDED],
  ["removed", CHANGE_STATUS.REMOVED],
  ["modified", CHANGE_STATUS.MODIFIED],
  ["renamed", CHANGE_STATUS.RENAMED],
  ["copied", CHANGE_STATUS.COPIED],
  ["changed", CHANGE_STATUS.CHANGED],
  // GraphQL (lower-cased before lookup); `deleted` is GraphQL's spelling of `removed`
  ["deleted", CHANGE_STATUS.REMOVED],
  // git name-status letters (lower-cased before lookup, score suffix stripped first)
  ["a", CHANGE_STATUS.ADDED],
  ["d", CHANGE_STATUS.REMOVED],
  ["m", CHANGE_STATUS.MODIFIED],
  ["r", CHANGE_STATUS.RENAMED],
  ["c", CHANGE_STATUS.COPIED],
  ["t", CHANGE_STATUS.CHANGED],
]);

/**
 * @param {unknown} raw  a REST / GraphQL / git status token (idempotent on its own output)
 * @returns {string} one of CHANGE_STATUS; anything unrecognized is `unknown`
 */
export function normalizeChangeStatus(raw) {
  if (typeof raw !== "string") return CHANGE_STATUS.UNKNOWN;
  // git appends a similarity score to R / C (`R100`, `C75`); other tokens never carry digits.
  const token = raw.trim().replace(/^([A-Za-z])\d+$/, "$1").toLowerCase();
  return NORMALIZED_BY_RAW.get(token) ?? CHANGE_STATUS.UNKNOWN;
}

/**
 * Parse `git diff --name-status -z` output. A plain record is `X\0path\0`; a rename / copy
 * record is `R<score>\0old\0new\0`. Throws on a malformed record so a parse problem never
 * silently reads as "modified" (the git-backed callers turn the throw into a failed probe).
 *
 * @returns {{status: string, path: string, previousPath: string|null}[]}
 */
export function parseGitNameStatusZ(text) {
  const entries = [];
  const tokens = String(text ?? "").split("\0");
  // `-z` output ends with a trailing NUL, so the last split element is empty.
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!/^[A-Za-z]\d*$/.test(code)) {
      throw new Error(`malformed name-status record: ${JSON.stringify(code)}`);
    }
    const status = normalizeChangeStatus(code);
    if (status === CHANGE_STATUS.RENAMED || status === CHANGE_STATUS.COPIED) {
      const previousPath = tokens[i++];
      const entryPath = tokens[i++];
      if (!previousPath || !entryPath) {
        throw new Error(`malformed name-status ${code} record: missing path`);
      }
      entries.push({ status, path: entryPath, previousPath });
    } else {
      const entryPath = tokens[i++];
      if (!entryPath) {
        throw new Error(`malformed name-status ${code} record: missing path`);
      }
      entries.push({ status, path: entryPath, previousPath: null });
    }
  }
  return entries;
}

/**
 * Turn per-file entries into the `(files, statuses)` pair the exemption classifiers take.
 *
 * `statuses` maps path -> normalized status. A rename / copy also contributes its SOURCE path
 * as a `removed` entry (a renamed-away proposal is a proposal that left the tree, which the
 * new-name-only file lists of REST and GraphQL cannot show), except a copy, whose source
 * stays in place. A non-`modified` status is never downgraded to `modified` by a later
 * duplicate entry for the same path.
 *
 * @param {{path: string, status: unknown, previousPath?: string|null}[]} entries
 * @returns {{files: string[], statuses: Map<string, string>}}
 */
export function toExemptionInput(entries) {
  const files = [];
  const statuses = new Map();
  const record = (filePath, status) => {
    if (typeof filePath !== "string" || filePath === "") return;
    const existing = statuses.get(filePath);
    if (existing === undefined) {
      files.push(filePath);
      statuses.set(filePath, status);
    } else if (existing === CHANGE_STATUS.MODIFIED && status !== CHANGE_STATUS.MODIFIED) {
      statuses.set(filePath, status);
    }
  };
  for (const entry of Array.isArray(entries) ? entries : []) {
    const status = normalizeChangeStatus(entry?.status);
    record(entry?.path, status);
    if (status === CHANGE_STATUS.RENAMED && entry?.previousPath) {
      record(entry.previousPath, CHANGE_STATUS.REMOVED);
    }
  }
  return { files, statuses };
}
